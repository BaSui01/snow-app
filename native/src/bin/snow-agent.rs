use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use chrono::{SecondsFormat, Utc};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::env;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime};
use uuid::Uuid;

const PROTOCOL_VERSION: u64 = 1;
const TERMINAL_STATUSES: &[&str] = &[
    "succeeded",
    "failed",
    "timed_out",
    "cancelled",
    "lost",
    "launch_failed",
    "indeterminate",
];
const STATE_LOCK_ATTEMPTS: usize = 400;
const LAUNCH_LOCK_OWNER_GRACE: Duration = Duration::from_secs(5);
const LAUNCH_LOCK_OWNER_FILE: &str = "launcher.pid";
const LAUNCH_LOCK_RUNNER_FILE: &str = "runner.pid";
const SELF_TEST_DELAY: Duration = Duration::from_millis(750);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentRequest {
    schema_version: u64,
    job_id: String,
    job_token_hash: String,
    working_directory: String,
    command: String,
    timeout_ms: u64,
    created_at: Option<String>,
    resource_limits: Option<ResourceLimits>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResourceLimits {
    max_log_bytes: Option<u64>,
    max_runtime_ms: Option<u64>,
}

fn main() {
    if let Err(error) = run() {
        eprintln!("snow-agent: {error}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), String> {
    let raw_args = env::args().skip(1).collect::<Vec<_>>();
    let args = raw_args.iter().map(String::as_str).collect::<Vec<_>>();
    match args.as_slice() {
        [command, format] if *command == "protocol" && *format == "--format=json" => {
            print_release_handshake()
        }
        ["job", "self-test", "--disconnect-survival"] => run_self_test(),
        ["job", "self-test-run", "--probe-id", probe_id, "--marker-token", marker_token] => {
            run_self_test_runner(probe_id, marker_token)
        }
        ["job", "launch", "--job-directory", directory] => launch_job(Path::new(directory)),
        ["job", "run", "--job-directory", directory] => run_job(Path::new(directory)),
        ["job", "attach", "--job-directory", directory] => attach_job(Path::new(directory)),
        ["job", "inspect", "--job-directory", directory] => inspect_job(Path::new(directory)),
        ["job", "cancel", "--job-directory", directory] => cancel_job(Path::new(directory)),
        ["file", "cas-write", "--target", target, "--expected-sha256", expected, "--content-base64", content] => {
            cas_write(Path::new(target), expected, content)
        }
        _ => Err("unsupported command".to_string()),
    }
}

fn print_json(value: Value) -> Result<(), String> {
    println!(
        "{}",
        serde_json::to_string(&value).map_err(|error| error.to_string())?
    );
    Ok(())
}

fn release_manifest_path() -> Result<PathBuf, String> {
    if let Some(path) = env::var_os("SNOW_AGENT_RELEASE_MANIFEST") {
        return Ok(PathBuf::from(path));
    }
    let executable = env::current_exe().map_err(|error| error.to_string())?;
    Ok(executable.with_file_name("snow-agent-release.json"))
}

fn print_release_handshake() -> Result<(), String> {
    let path = release_manifest_path()?;
    let content = fs::read_to_string(&path)
        .map_err(|_| format!("signed release manifest is missing: {}", path.display()))?;
    let manifest: Value = serde_json::from_str(&content)
        .map_err(|error| format!("signed release manifest is invalid: {error}"))?;
    let protocol = manifest
        .get("protocolVersion")
        .and_then(Value::as_u64)
        .ok_or_else(|| "signed release manifest has no protocolVersion".to_string())?;
    if protocol != PROTOCOL_VERSION {
        return Err(format!("release protocol {protocol} is unsupported"));
    }
    let declared_hash = manifest
        .get("artifactSha256")
        .and_then(Value::as_str)
        .ok_or_else(|| "signed release manifest has no artifactSha256".to_string())?;
    let executable = env::current_exe().map_err(|error| error.to_string())?;
    let actual_hash = sha256(&fs::read(&executable).map_err(|error| error.to_string())?);
    if !declared_hash.eq_ignore_ascii_case(&actual_hash) {
        return Err("snow-agent binary does not match its signed release manifest".to_string());
    }
    print_json(manifest)
}

fn self_test_root() -> Result<PathBuf, String> {
    let root = env::var_os("XDG_STATE_HOME")
        .map(PathBuf::from)
        .or_else(|| env::var_os("HOME").map(|home| PathBuf::from(home).join(".local/state")))
        .unwrap_or_else(|| PathBuf::from("."))
        .join("snow-app/jobs");
    fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    #[cfg(unix)]
    fs::set_permissions(&root, fs::Permissions::from_mode(0o700))
        .map_err(|error| error.to_string())?;
    Ok(root)
}

fn self_test_marker(root: &Path, probe_id: &str) -> Result<PathBuf, String> {
    Uuid::parse_str(probe_id).map_err(|_| "invalid self-test probe id".to_string())?;
    Ok(root.join(format!(".snow-agent-self-test-{probe_id}")))
}

fn run_self_test() -> Result<(), String> {
    // The caller closes its SSH session before it reads this marker. Keep the
    // launch mechanism shared with actual runners so the probe exercises the
    // same session-detachment path instead of self-certifying synchronously.
    let probe_id = Uuid::new_v4().to_string();
    let marker_token = Uuid::new_v4().to_string();
    let root = self_test_root()?;
    let _marker = self_test_marker(&root, &probe_id)?;
    let executable = env::current_exe().map_err(|error| error.to_string())?;
    launch_self_test_runner(&executable, &probe_id, &marker_token)?;
    print_json(json!({
        "accepted": true,
        "probeId": probe_id,
        "markerToken": marker_token,
    }))
}

fn run_self_test_runner(probe_id: &str, marker_token: &str) -> Result<(), String> {
    Uuid::parse_str(marker_token).map_err(|_| "invalid self-test marker token".to_string())?;
    run_self_test_runner_at(&self_test_root()?, probe_id, marker_token)
}

fn run_self_test_runner_at(root: &Path, probe_id: &str, marker_token: &str) -> Result<(), String> {
    let marker = self_test_marker(root, probe_id)?;
    thread::sleep(SELF_TEST_DELAY);
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&marker)
        .map_err(|error| format!("failed to create self-test marker: {error}"))?;
    file.write_all(marker_token.as_bytes())
        .map_err(|error| format!("failed to write self-test marker: {error}"))?;
    file.sync_all()
        .map_err(|error| format!("failed to sync self-test marker: {error}"))
}

fn read_request(directory: &Path) -> Result<AgentRequest, String> {
    let content = fs::read_to_string(directory.join("agent-request.json"))
        .map_err(|error| format!("failed to read agent request: {error}"))?;
    let request: AgentRequest = serde_json::from_str(&content)
        .map_err(|error| format!("invalid agent request: {error}"))?;
    if request.schema_version != PROTOCOL_VERSION || request.job_id.is_empty() {
        return Err("agent request has an unsupported schema or empty job id".to_string());
    }
    if request.job_token_hash.len() != 64 || request.command.trim().is_empty() {
        return Err("agent request is missing the cleanup token or command".to_string());
    }
    Ok(request)
}

fn read_state(directory: &Path) -> Option<Value> {
    fs::read_to_string(directory.join("state.json"))
        .ok()
        .and_then(|content| serde_json::from_str(&content).ok())
}

fn state_is_terminal(state: &Value) -> bool {
    state
        .get("status")
        .and_then(Value::as_str)
        .is_some_and(|status| TERMINAL_STATUSES.contains(&status))
}

fn next_revision(directory: &Path) -> u64 {
    let revision_path = directory.join("revision");
    let current = fs::read_to_string(&revision_path)
        .ok()
        .and_then(|value| value.trim().parse::<u64>().ok())
        .unwrap_or(0);
    let next = current + 1;
    let _ = fs::write(revision_path, next.to_string());
    next
}

struct StateLock {
    path: PathBuf,
}

impl Drop for StateLock {
    fn drop(&mut self) {
        let _ = fs::remove_dir(&self.path);
    }
}

fn acquire_state_lock(directory: &Path) -> Result<StateLock, String> {
    let path = directory.join("state.lock");
    for _ in 0..STATE_LOCK_ATTEMPTS {
        match fs::create_dir(&path) {
            Ok(()) => return Ok(StateLock { path }),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                thread::sleep(Duration::from_millis(25));
            }
            Err(error) => return Err(format!("failed to acquire state lock: {error}")),
        }
    }
    Err("remote job state lock timed out".to_string())
}

fn timestamp() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn write_state(
    directory: &Path,
    request: &AgentRequest,
    status: &str,
    exit_code: Option<i32>,
    reason: Option<&str>,
) -> Result<(), String> {
    write_state_with_runner_pid(
        directory,
        request,
        status,
        exit_code,
        reason,
        Some(std::process::id()),
    )
}

fn write_launching_state(directory: &Path, request: &AgentRequest) -> Result<(), String> {
    write_state_with_runner_pid(directory, request, "launching", None, None, None)
}

fn write_state_with_runner_pid(
    directory: &Path,
    request: &AgentRequest,
    status: &str,
    exit_code: Option<i32>,
    reason: Option<&str>,
    runner_pid: Option<u32>,
) -> Result<(), String> {
    let _state_lock = acquire_state_lock(directory)?;
    let truncated = if let Some(current) = read_state(directory) {
        if state_is_terminal(&current) {
            return Ok(());
        }
        current
            .get("truncated")
            .and_then(Value::as_bool)
            .unwrap_or(false)
    } else {
        false
    };
    let now = timestamp();
    let mut state = json!({
        "schemaVersion": PROTOCOL_VERSION,
        "jobId": request.job_id,
        "status": status,
        "revision": next_revision(directory),
        "backend": "snow-agent",
        "createdAt": request.created_at.clone().unwrap_or_else(|| now.clone()),
        "updatedAt": now,
        "exitCode": exit_code,
    });
    if let Some(runner_pid) = runner_pid {
        state["runnerPid"] = json!(runner_pid);
    }
    if TERMINAL_STATUSES.contains(&status) {
        state["completedAt"] = Value::String(timestamp());
    }
    if let Some(reason) = reason.filter(|reason| !reason.is_empty()) {
        state["reason"] = Value::String(reason.to_string());
    }
    if truncated {
        state["truncated"] = Value::Bool(true);
    }
    let temporary = directory.join(format!("state.{}.tmp", Uuid::new_v4()));
    fs::write(
        &temporary,
        serde_json::to_vec(&state).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    fs::rename(temporary, directory.join("state.json")).map_err(|error| error.to_string())
}

fn mark_output_truncated(directory: &Path) -> Result<(), String> {
    let _state_lock = acquire_state_lock(directory)?;
    let Some(mut state) = read_state(directory) else {
        return Ok(());
    };
    if state_is_terminal(&state) || state["truncated"].as_bool() == Some(true) {
        return Ok(());
    }
    state["truncated"] = Value::Bool(true);
    state["revision"] = Value::from(next_revision(directory));
    state["updatedAt"] = Value::String(timestamp());
    let temporary = directory.join(format!("state.{}.tmp", Uuid::new_v4()));
    fs::write(
        &temporary,
        serde_json::to_vec(&state).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    fs::rename(temporary, directory.join("state.json")).map_err(|error| error.to_string())
}

#[cfg(unix)]
fn launch_detached<F>(executable: &Path, configure: F) -> Result<(), String>
where
    F: FnOnce(&mut Command),
{
    use std::os::unix::process::CommandExt;

    let mut command = Command::new(executable);
    configure(&mut command);
    // Calling setsid(2) in the child keeps the agent portable across POSIX
    // hosts. macOS does not ship the GNU `setsid` executable used previously.
    unsafe {
        command.pre_exec(|| {
            if libc::setsid() == -1 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        });
    }
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("failed to start detached runner: {error}"))
}

#[cfg(not(unix))]
fn launch_detached<F>(_executable: &Path, _configure: F) -> Result<(), String>
where
    F: FnOnce(&mut Command),
{
    Err("snow-agent runner is currently published for POSIX hosts only".to_string())
}

fn launch_runner(executable: &Path, directory: &Path) -> Result<(), String> {
    launch_detached(executable, |command| {
        command
            .args(["job", "run", "--job-directory"])
            .arg(directory);
    })
}

fn launch_self_test_runner(
    executable: &Path,
    probe_id: &str,
    marker_token: &str,
) -> Result<(), String> {
    launch_detached(executable, |command| {
        command.args([
            "job",
            "self-test-run",
            "--probe-id",
            probe_id,
            "--marker-token",
            marker_token,
        ]);
    })
}

struct LaunchLock {
    path: PathBuf,
    release_on_drop: bool,
}

impl LaunchLock {
    fn acquire(directory: &Path) -> Result<Self, io::Error> {
        let path = directory.join("launch.lock");
        fs::create_dir(&path)?;
        let lock = Self {
            path,
            release_on_drop: true,
        };
        if let Err(error) = fs::write(
            lock.path.join(LAUNCH_LOCK_OWNER_FILE),
            std::process::id().to_string(),
        ) {
            return Err(error);
        }
        Ok(lock)
    }

    fn claim_for_runner(directory: &Path) -> Result<Self, String> {
        let path = directory.join("launch.lock");
        if !path.is_dir() {
            return Err("snow-agent runner started without a launch handoff lock".to_string());
        }
        let runner_marker = path.join(LAUNCH_LOCK_RUNNER_FILE);
        OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&runner_marker)
            .and_then(|mut file| write!(file, "{}", std::process::id()))
            .map_err(|error| format!("failed to claim launch handoff lock: {error}"))?;
        Ok(Self {
            path,
            release_on_drop: true,
        })
    }

    fn hand_off(mut self) {
        self.release_on_drop = false;
    }

    fn release(&mut self) -> Result<(), String> {
        release_launch_lock(&self.path)?;
        self.release_on_drop = false;
        Ok(())
    }
}

impl Drop for LaunchLock {
    fn drop(&mut self) {
        if self.release_on_drop {
            let _ = release_launch_lock(&self.path);
        }
    }
}

fn read_lock_pid(path: &Path, name: &str) -> Option<u32> {
    fs::read_to_string(path.join(name))
        .ok()
        .and_then(|value| value.trim().parse::<u32>().ok())
}

#[cfg(unix)]
fn process_is_active(pid: u32) -> bool {
    if pid == 0 || pid > i32::MAX as u32 {
        return false;
    }
    Command::new("kill")
        .args(["-0", &pid.to_string()])
        .status()
        .is_ok_and(|status| status.success())
}

#[cfg(not(unix))]
fn process_is_active(_pid: u32) -> bool {
    false
}

fn launch_lock_is_active(path: &Path) -> bool {
    if read_lock_pid(path, LAUNCH_LOCK_RUNNER_FILE).is_some_and(process_is_active) {
        return true;
    }
    let Some(owner_pid) = read_lock_pid(path, LAUNCH_LOCK_OWNER_FILE) else {
        // Older agents created an empty lock directory. A dead runner PID in
        // state.json is enough to reclaim that legacy lock immediately.
        return false;
    };
    if process_is_active(owner_pid) {
        return true;
    }
    fs::metadata(path)
        .and_then(|metadata| metadata.modified())
        .and_then(|modified| modified.elapsed().map_err(io::Error::other))
        .is_ok_and(|elapsed| elapsed < LAUNCH_LOCK_OWNER_GRACE)
}

fn release_launch_lock(path: &Path) -> Result<(), String> {
    for marker in [LAUNCH_LOCK_RUNNER_FILE, LAUNCH_LOCK_OWNER_FILE] {
        match fs::remove_file(path.join(marker)) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("failed to release launch lock: {error}")),
        }
    }
    fs::remove_dir(path).map_err(|error| format!("failed to release launch lock: {error}"))
}

fn acquire_or_recover_launch_lock(directory: &Path) -> Result<Option<LaunchLock>, String> {
    match LaunchLock::acquire(directory) {
        Ok(lock) => Ok(Some(lock)),
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
            let path = directory.join("launch.lock");
            if launch_lock_is_active(&path) {
                return Ok(None);
            }
            release_launch_lock(&path)?;
            match LaunchLock::acquire(directory) {
                Ok(lock) => Ok(Some(lock)),
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => Ok(None),
                Err(error) => Err(format!("failed to acquire launch lock: {error}")),
            }
        }
        Err(error) => Err(format!("failed to acquire launch lock: {error}")),
    }
}

fn launch_job_with<F>(directory: &Path, launch_runner: F) -> Result<(), String>
where
    F: FnOnce(&Path) -> Result<(), String>,
{
    let request = read_request(directory)?;
    if let Some(state) = read_state(directory) {
        let status = state.get("status").and_then(Value::as_str);
        if state_is_terminal(&state) || status == Some("running") {
            return print_json(json!({ "accepted": true, "jobId": request.job_id }));
        }
        if status == Some("launching")
            && state
                .get("runnerPid")
                .and_then(Value::as_u64)
                .and_then(|pid| u32::try_from(pid).ok())
                .is_some_and(process_is_active)
        {
            return print_json(json!({ "accepted": true, "jobId": request.job_id }));
        }
    }
    let Some(lock) = acquire_or_recover_launch_lock(directory)? else {
        return print_json(json!({ "accepted": true, "jobId": request.job_id }));
    };
    write_launching_state(directory, &request)?;
    if let Err(error) = launch_runner(directory) {
        let _ = write_state(directory, &request, "launch_failed", None, Some(&error));
        return Err(error);
    }
    lock.hand_off();
    print_json(json!({ "accepted": true, "jobId": request.job_id }))
}

fn launch_job(directory: &Path) -> Result<(), String> {
    let executable = env::current_exe().map_err(|error| error.to_string())?;
    launch_job_with(directory, |directory| launch_runner(&executable, directory))
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

struct OutputCapture {
    log: File,
    frames: File,
    offset: u64,
    used_bytes: u64,
    max_bytes: u64,
    truncated: bool,
}

impl OutputCapture {
    fn open(directory: &Path, max_bytes: u64) -> Result<Self, String> {
        let log_path = directory.join("output.log");
        let frames_path = directory.join("output.frames.ndjson");
        let log_bytes = fs::metadata(&log_path)
            .map(|metadata| metadata.len())
            .unwrap_or(0);
        let frame_bytes = fs::metadata(&frames_path)
            .map(|metadata| metadata.len())
            .unwrap_or(0);
        Ok(Self {
            log: OpenOptions::new()
                .create(true)
                .append(true)
                .open(log_path)
                .map_err(|error| error.to_string())?,
            frames: OpenOptions::new()
                .create(true)
                .append(true)
                .open(frames_path)
                .map_err(|error| error.to_string())?,
            offset: log_bytes,
            used_bytes: log_bytes.saturating_add(frame_bytes),
            max_bytes,
            truncated: log_bytes.saturating_add(frame_bytes) >= max_bytes,
        })
    }

    fn frame(start: u64, stream: &str, chunk: &[u8]) -> Result<Vec<u8>, String> {
        let mut frame = serde_json::to_vec(&json!({
            "offset": start,
            "stream": stream,
            "data": BASE64.encode(chunk),
        }))
        .map_err(|error| error.to_string())?;
        frame.push(b'\n');
        Ok(frame)
    }

    fn largest_recordable_chunk(&self, stream: &str, chunk: &[u8]) -> Result<usize, String> {
        let remaining = self.max_bytes.saturating_sub(self.used_bytes);
        let mut low = 0;
        let mut high = chunk
            .len()
            .min(usize::try_from(remaining).unwrap_or(usize::MAX));
        while low < high {
            let middle = low + (high - low + 1) / 2;
            let frame = Self::frame(self.offset, stream, &chunk[..middle])?;
            if middle as u64 + frame.len() as u64 <= remaining {
                low = middle;
            } else {
                high = middle - 1;
            }
        }
        Ok(low)
    }

    fn capture(&mut self, stream: &str, chunk: &[u8]) -> Result<bool, String> {
        if self.truncated {
            return Ok(false);
        }
        let length = self.largest_recordable_chunk(stream, chunk)?;
        if length == 0 {
            self.truncated = true;
            return Ok(true);
        }
        let frame = Self::frame(self.offset, stream, &chunk[..length])?;
        self.log
            .write_all(&chunk[..length])
            .map_err(|error| error.to_string())?;
        self.frames
            .write_all(&frame)
            .map_err(|error| error.to_string())?;
        self.offset += length as u64;
        self.used_bytes += length as u64 + frame.len() as u64;
        if length < chunk.len() {
            self.truncated = true;
            return Ok(true);
        }
        Ok(false)
    }

    fn is_truncated(&self) -> bool {
        self.truncated
    }
}

fn capture_stream<R: Read + Send + 'static>(
    mut reader: R,
    stream: &'static str,
    output: Arc<Mutex<OutputCapture>>,
    directory: PathBuf,
) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        let mut buffer = [0u8; 16 * 1024];
        loop {
            let read = match reader.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(read) => read,
            };
            let chunk = &buffer[..read];
            let truncated = output
                .lock()
                .expect("output capture lock poisoned")
                .capture(stream, chunk)
                .unwrap_or(false);
            if truncated {
                let _ = mark_output_truncated(&directory);
            }
        }
    })
}

fn terminate_process_group(child: &mut Child) {
    #[cfg(unix)]
    {
        let _ = Command::new("kill")
            .args(["-TERM", &format!("-{}", child.id())])
            .status();
    }
    let _ = child.kill();
}

fn run_job(directory: &Path) -> Result<(), String> {
    let request = read_request(directory)?;
    let mut lock = LaunchLock::claim_for_runner(directory)?;
    if read_state(directory).is_some_and(|state| state_is_terminal(&state)) {
        return lock.release();
    }
    write_state(directory, &request, "launching", None, None)?;
    lock.release()?;
    run_job_after_handoff(directory, &request)
}

fn run_job_after_handoff(directory: &Path, request: &AgentRequest) -> Result<(), String> {
    let max_runtime_ms = request
        .resource_limits
        .as_ref()
        .and_then(|limits| limits.max_runtime_ms)
        .unwrap_or(request.timeout_ms)
        .min(request.timeout_ms);
    let max_output_bytes = request
        .resource_limits
        .as_ref()
        .and_then(|limits| limits.max_log_bytes)
        .unwrap_or(50 * 1024 * 1024);
    let output = Arc::new(Mutex::new(OutputCapture::open(
        directory,
        max_output_bytes,
    )?));
    if output
        .lock()
        .expect("output capture lock poisoned")
        .is_truncated()
    {
        mark_output_truncated(directory)?;
    }
    let wrapped = format!(
        "ulimit -f {} 2>/dev/null || true; exec /bin/sh -lc {}",
        max_output_bytes / 512,
        shell_quote(&request.command)
    );
    let mut child = Command::new("setsid")
        .args(["/bin/sh", "-lc", &wrapped])
        .current_dir(&request.working_directory)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("failed to start job command: {error}"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "missing job stdout".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "missing job stderr".to_string())?;
    let stdout_reader = capture_stream(stdout, "stdout", output.clone(), directory.to_path_buf());
    let stderr_reader = capture_stream(stderr, "stderr", output, directory.to_path_buf());
    write_state(directory, &request, "running", None, None)?;
    let started = SystemTime::now();
    let mut cancelled = false;
    let mut timed_out = false;
    let exit_code = loop {
        if directory.join("cancel.request").exists() {
            cancelled = true;
            terminate_process_group(&mut child);
        } else if started.elapsed().unwrap_or_default() >= Duration::from_millis(max_runtime_ms) {
            timed_out = true;
            terminate_process_group(&mut child);
        }
        if let Some(status) = child.try_wait().map_err(|error| error.to_string())? {
            break status.code().unwrap_or(1);
        }
        thread::sleep(Duration::from_millis(200));
    };
    let _ = stdout_reader.join();
    let _ = stderr_reader.join();
    if timed_out {
        write_state(
            directory,
            &request,
            "timed_out",
            Some(exit_code),
            Some("timeout"),
        )
    } else if cancelled {
        write_state(
            directory,
            &request,
            "cancelled",
            Some(exit_code),
            Some("cancelled"),
        )
    } else if exit_code == 0 {
        write_state(directory, &request, "succeeded", Some(0), None)
    } else {
        write_state(directory, &request, "failed", Some(exit_code), Some("exit"))
    }
}

fn inspect_job(directory: &Path) -> Result<(), String> {
    let state = read_state(directory).ok_or_else(|| "job state is unavailable".to_string())?;
    let active = state
        .get("status")
        .and_then(Value::as_str)
        .is_some_and(|status| !TERMINAL_STATUSES.contains(&status))
        && state
            .get("runnerPid")
            .and_then(Value::as_u64)
            .and_then(|pid| u32::try_from(pid).ok())
            .is_some_and(process_is_active);
    print_json(json!({ "active": active, "state": state }))
}

fn attach_job(directory: &Path) -> Result<(), String> {
    let output_path = directory.join("output.log");
    let mut offset = 0_u64;
    let stdout = io::stdout();
    let mut output = stdout.lock();
    loop {
        let content = fs::read(&output_path).unwrap_or_default();
        let available = u64::try_from(content.len()).map_err(|error| error.to_string())?;
        if available < offset {
            // The retained log was replaced while a terminal was attached.
            // Restart from its beginning rather than silently skipping output.
            offset = 0;
        }
        if available > offset {
            let start = usize::try_from(offset).map_err(|error| error.to_string())?;
            output
                .write_all(&content[start..])
                .and_then(|()| output.flush())
                .map_err(|error| format!("failed to write attached output: {error}"))?;
            offset = available;
        }
        if read_state(directory).is_some_and(|state| state_is_terminal(&state)) {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(100));
    }
}

fn cancel_job(directory: &Path) -> Result<(), String> {
    fs::write(directory.join("cancel.request"), b"").map_err(|error| error.to_string())?;
    print_json(json!({ "accepted": true }))
}

fn sha256(content: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(content);
    format!("{:x}", hasher.finalize())
}

fn cas_write(target: &Path, expected: &str, content: &str) -> Result<(), String> {
    let current = fs::read(target).ok();
    let current_hash = current.as_deref().map(sha256);
    if (expected == "missing" && current.is_some())
        || (expected != "missing" && current_hash.as_deref() != Some(expected))
    {
        return Err("CAS precondition failed".to_string());
    }
    let decoded = BASE64
        .decode(content)
        .map_err(|error| format!("invalid base64 content: {error}"))?;
    let parent = target
        .parent()
        .ok_or_else(|| "target has no parent directory".to_string())?;
    let temporary = parent.join(format!(
        ".{}.snow-agent-{}.tmp",
        target
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("target"),
        Uuid::new_v4()
    ));
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .and_then(|mut file| {
            file.write_all(&decoded)?;
            file.sync_all()
        })
        .map_err(|error| error.to_string())?;
    fs::rename(&temporary, target).map_err(|error| error.to_string())?;
    print_json(json!({ "committed": true, "sha256": sha256(&decoded), "bytes": decoded.len() }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_job_directory() -> PathBuf {
        let directory = env::temp_dir().join(format!("snow-agent-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&directory).expect("create test job directory");
        directory
    }

    fn write_test_request(directory: &Path, working_directory: &Path) {
        fs::write(
            directory.join("agent-request.json"),
            serde_json::to_vec(&json!({
                "schemaVersion": PROTOCOL_VERSION,
                "jobId": Uuid::new_v4().to_string(),
                "jobTokenHash": "a".repeat(64),
                "workingDirectory": working_directory,
                "command": "true",
                "timeoutMs": 1_000,
            }))
            .expect("serialize agent request"),
        )
        .expect("write agent request");
    }

    #[cfg(unix)]
    #[test]
    fn runner_releases_handoff_lock_before_a_missing_working_directory_fails() {
        let directory = test_job_directory();
        let missing_working_directory = directory.join("deleted-workspace");
        write_test_request(&directory, &missing_working_directory);
        let lock = directory.join("launch.lock");
        fs::create_dir(&lock).expect("create handoff lock");
        fs::write(lock.join(LAUNCH_LOCK_OWNER_FILE), "1").expect("write launcher marker");

        let error = run_job(&directory).expect_err("missing working directory must fail");
        assert!(error.contains("failed to start job command"));
        assert!(!lock.exists(), "runner must release the handoff lock");
        let state = read_state(&directory).expect("runner writes its launching state");
        assert_eq!(state["status"], "launching");
        assert_eq!(state["runnerPid"], std::process::id());

        fs::remove_dir_all(directory).expect("remove test job directory");
    }

    #[test]
    fn stale_launching_state_reclaims_a_legacy_lock_and_relaunches() {
        let directory = test_job_directory();
        write_test_request(&directory, &directory);
        let request = read_request(&directory).expect("read test request");
        fs::write(
            directory.join("state.json"),
            serde_json::to_vec(&json!({
                "schemaVersion": PROTOCOL_VERSION,
                "jobId": request.job_id,
                "status": "launching",
                "revision": 1,
                "backend": "snow-agent",
                "runnerPid": u32::MAX,
                "createdAt": "unix-ms:0",
                "updatedAt": "unix-ms:0",
                "exitCode": null,
            }))
            .expect("serialize stale state"),
        )
        .expect("write stale state");
        fs::create_dir(directory.join("launch.lock")).expect("create legacy lock");

        let mut launches = 0;
        launch_job_with(&directory, |_| {
            launches += 1;
            Ok(())
        })
        .expect("stale launch must be retried");
        assert_eq!(launches, 1);
        assert!(directory.join("launch.lock").is_dir());

        release_launch_lock(&directory.join("launch.lock")).expect("release test lock");
        fs::remove_dir_all(directory).expect("remove test job directory");
    }

    #[test]
    fn self_test_runner_writes_a_delayed_token_marker() {
        let root = test_job_directory();
        let probe_id = Uuid::new_v4().to_string();
        let marker_token = Uuid::new_v4().to_string();
        let marker = self_test_marker(&root, &probe_id).expect("build self-test marker path");
        let started = Instant::now();

        run_self_test_runner_at(&root, &probe_id, &marker_token)
            .expect("write delayed self-test marker");

        assert!(
            started.elapsed() >= SELF_TEST_DELAY,
            "the marker must not be written before the launching SSH session can close"
        );
        assert_eq!(
            fs::read_to_string(&marker).expect("read self-test marker"),
            marker_token
        );

        fs::remove_file(marker).expect("remove self-test marker");
        fs::remove_dir_all(root).expect("remove test job directory");
    }

    #[test]
    fn attach_replays_completed_job_output() {
        let directory = test_job_directory();
        fs::write(directory.join("output.log"), b"completed output\n")
            .expect("write completed output");
        fs::write(
            directory.join("state.json"),
            serde_json::to_vec(&json!({ "status": "succeeded" }))
                .expect("serialize completed state"),
        )
        .expect("write completed state");

        attach_job(&directory).expect("attach must replay output then return for completed jobs");

        fs::remove_dir_all(directory).expect("remove test job directory");
    }

    #[test]
    fn writes_iso_8601_timestamps_to_terminal_state() {
        let directory = test_job_directory();
        write_test_request(&directory, &directory);
        let request = read_request(&directory).expect("read test request");

        write_state(&directory, &request, "succeeded", Some(0), None)
            .expect("write completed state");

        let state = read_state(&directory).expect("read completed state");
        for field in ["createdAt", "updatedAt", "completedAt"] {
            let value = state[field].as_str().expect("timestamp must be a string");
            assert!(
                chrono::DateTime::parse_from_rfc3339(value).is_ok(),
                "{field} must be an ISO-8601 timestamp: {value}"
            );
        }

        fs::remove_dir_all(directory).expect("remove test job directory");
    }

    #[test]
    fn output_capture_bounds_log_and_frames_and_preserves_truncation_state() {
        let directory = test_job_directory();
        write_test_request(&directory, &directory);
        let request = read_request(&directory).expect("read test request");
        write_state(&directory, &request, "running", None, None).expect("write running state");

        let output = Arc::new(Mutex::new(
            OutputCapture::open(&directory, 512).expect("open output capture"),
        ));
        let reader = io::Cursor::new(vec![b'x'; 16 * 1024]);
        capture_stream(reader, "stdout", output, directory.clone())
            .join()
            .expect("join output capture");
        write_state(&directory, &request, "succeeded", Some(0), None)
            .expect("write completed state");

        let log = fs::read(directory.join("output.log")).expect("read output log");
        let frame_line =
            fs::read_to_string(directory.join("output.frames.ndjson")).expect("read output frames");
        let frame: Value = serde_json::from_str(frame_line.trim()).expect("parse output frame");
        let framed = BASE64
            .decode(frame["data"].as_str().expect("frame data"))
            .expect("decode frame data");
        let stored_bytes = fs::metadata(directory.join("output.log"))
            .expect("stat output log")
            .len()
            + fs::metadata(directory.join("output.frames.ndjson"))
                .expect("stat output frames")
                .len();
        let state = read_state(&directory).expect("read completed state");

        assert!(!log.is_empty());
        assert_eq!(framed, log);
        assert!(stored_bytes <= 512, "combined output must fit the quota");
        assert_eq!(state["status"], "succeeded");
        assert_eq!(state["truncated"], true);

        fs::remove_dir_all(directory).expect("remove test job directory");
    }
}
