use napi::bindgen_prelude::*;
use napi::threadsafe_function::ThreadsafeFunction;
use napi_derive::napi;
use serde_json::{json, Value};

use super::super::service::McpService;
use super::super::tools::McpTool;

mod validation;

const SERVER_ID: &str = "browser";
const DEFAULT_TIMEOUT_MS: u64 = 30_000;
const MIN_TIMEOUT_MS: u64 = 1_000;
const MAX_TIMEOUT_MS: u64 = 120_000;
const DEFAULT_MAX_CONTENT_LENGTH: u64 = 20_000;
const MIN_MAX_CONTENT_LENGTH: u64 = 1_000;
const MAX_MAX_CONTENT_LENGTH: u64 = 100_000;
const MAX_WAIT_TIME_MS: u64 = 30_000;

#[napi(object)]
pub struct BrowserCommand {
    pub operation: String,
    pub args_json: String,
}

pub type BrowserCommandCallback =
    ThreadsafeFunction<BrowserCommand, Promise<String>, BrowserCommand, Status, false>;

pub struct BrowserService;

impl BrowserService {
    pub fn new() -> Self {
        BrowserService
    }

    pub async fn execute_async(
        &self,
        tool_name: &str,
        args: &Value,
        on_command: &BrowserCommandCallback,
    ) -> napi::Result<Value> {
        let normalized_args = validation::validate_and_normalize_args(tool_name, args)?;
        let command = BrowserCommand {
            operation: tool_name.to_string(),
            args_json: serde_json::to_string(&normalized_args).map_err(|error| {
                Error::new(
                    Status::GenericFailure,
                    format!("Failed to serialize browser command: {error}"),
                )
            })?,
        };

        let promise = on_command
            .call_async_catch(command)
            .await
            .map_err(|error| {
                Error::new(
                    Status::GenericFailure,
                    format!("Failed to dispatch browser command to Electron: {error}"),
                )
            })?;
        let result_json = promise.await.map_err(|error| {
            Error::new(
                Status::GenericFailure,
                format!("Browser command failed: {error}"),
            )
        })?;

        serde_json::from_str(&result_json).map_err(|error| {
            Error::new(
                Status::GenericFailure,
                format!("Browser command returned invalid JSON: {error}"),
            )
        })
    }
}

impl McpService for BrowserService {
    fn id(&self) -> &str {
        SERVER_ID
    }

    fn tools(&self) -> Vec<McpTool> {
        let mut tools = vec![
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: "create".to_string(),
                description: "Create a new embedded browser tab in the right panel (each browser tab hosts one page and its instanceId is the tab ID). Returns an instanceId for explicitly targeting it later. Optionally opens an initial URL. Tabs created this way count as shared with the agent and use an isolated session by default (their own cookies/storage, no access to the user's login state).".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "url": {
                            "type": "string",
                            "description": "Optional initial URL (http://, https://, or file://). If omitted, the configured browser homepage is used."
                        }
                    }
                }),
            },
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: "navigate".to_string(),
                description: "Navigate an embedded browser instance to a URL (http://, https://, or file://) and wait asynchronously for loading to finish, or reload the current page with reload=true (optionally ignoreCache=true). initScript injects JavaScript before any other script runs in the next document (one-shot, credential access blocked). Omit instanceId to use the most recently focused browser tab, including a browser opened by the user.".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "instanceId": {
                            "type": "string",
                            "description": "Optional browser instance ID. Omit it or use current to target the most recently focused embedded browser tab."
                        },
                        "url": {
                            "type": "string",
                            "description": "URL to visit (http://, https://, or file://). Omit when reload=true."
                        },
                        "reload": {
                            "type": "boolean",
                            "description": "Reload the current page instead of navigating to url (default false).",
                            "default": false
                        },
                        "ignoreCache": {
                            "type": "boolean",
                            "description": "Bypass the cache when reloading (reload=true only).",
                            "default": false
                        },
                        "initScript": {
                            "type": "string",
                            "description": "JavaScript to execute before any other script of the next document (one-shot; credential/storage access is blocked)."
                        },
                        "timeoutMs": {
                            "type": "number",
                            "description": "Navigation timeout in milliseconds (default 30000, range 1000-120000).",
                            "default": DEFAULT_TIMEOUT_MS,
                            "minimum": MIN_TIMEOUT_MS,
                            "maximum": MAX_TIMEOUT_MS
                        }
                    }
                }),
            },
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: "click".to_string(),
                description: "Click page content in an embedded browser with a real Electron mouse input event. Target an element with a CSS selector, visible text, or an accessibility ref (uid=... from browser-devtools action=ax), or click viewport coordinates with x and y. Set dblClick to double-click. Omit instanceId to use the most recently focused browser tab, including a browser opened by the user.".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "instanceId": {
                            "type": "string",
                            "description": "Optional browser instance ID. Omit it or use current to target the most recently focused embedded browser tab."
                        },
                        "selector": {
                            "type": "string",
                            "description": "Optional CSS selector for the element to click."
                        },
                        "text": {
                            "type": "string",
                            "description": "Optional visible text to locate when selector is not provided."
                        },
                        "ref": {
                            "type": "string",
                            "description": "Optional accessibility ref (uid from a recent browser-devtools action=ax snapshot) for deterministic element targeting."
                        },
                        "x": {
                            "type": "number",
                            "description": "Viewport x coordinate to click (main frame only; provide both x and y instead of selector/text/ref)."
                        },
                        "y": {
                            "type": "number",
                            "description": "Viewport y coordinate to click (main frame only; provide both x and y instead of selector/text/ref)."
                        },
                        "dblClick": {
                            "type": "boolean",
                            "description": "Whether to double-click the target (default false).",
                            "default": false
                        },
                        "exact": {
                            "type": "boolean",
                            "description": "Whether text matching must be exact (default false).",
                            "default": false
                        }
                    },
                    "anyOf": [
                        { "required": ["selector"] },
                        { "required": ["text"] },
                        { "required": ["ref"] },
                        { "required": ["x", "y"] }
                    ]
                }),
            },
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: "screenshot".to_string(),
                description: "Capture an embedded browser page or a single element as an image (CDP, including off-screen content). Pass selector or ref to capture only that element, format/quality to choose the output type, and filePath to save the image to a file instead of returning it inline. Omit instanceId to capture the most recently focused browser tab, including a browser opened by the user. Returns page metadata and, when filePath is omitted, an image content block containing base64 image data.".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "instanceId": {
                            "type": "string",
                            "description": "Optional browser instance ID. Omit it or use current to target the most recently focused embedded browser tab."
                        },
                        "fullPage": {
                            "type": "boolean",
                            "description": "Capture the full scrollable page instead of only the viewport (default false).",
                            "default": false
                        },
                        "selector": {
                            "type": "string",
                            "description": "Optional CSS selector; capture only that element (mutually exclusive with fullPage)."
                        },
                        "ref": {
                            "type": "string",
                            "description": "Optional accessibility ref (uid from a recent browser-devtools action=ax snapshot); capture only that element (mutually exclusive with fullPage)."
                        },
                        "format": {
                            "type": "string",
                            "enum": ["png", "jpeg", "webp"],
                            "description": "Image format (default png).",
                            "default": "png"
                        },
                        "quality": {
                            "type": "number",
                            "description": "Compression quality 0-100 for jpeg/webp formats (ignored for png).",
                            "minimum": 0,
                            "maximum": 100
                        },
                        "filePath": {
                            "type": "string",
                            "description": "Optional absolute path; save the image to this file instead of returning base64 data inline."
                        }
                    }
                }),
            },
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: "devtools".to_string(),
                description: "Inspect developer-tools-related information for an embedded browser. Omit instanceId to inspect the most recently focused browser tab, including a browser opened by the user. Use action=snapshot for page metadata and text, action=console for captured console messages (filterable by level/types, paginated with pageIdx/pageSize, includePreserved covers the last 3 navigations, clearConsole clears after returning), action=console_message for one message by msgid, action=network for recorded network requests (filterable by regexp/resourceTypes, paginated, includePreserved covers the last 3 navigations; CDP records include a numeric id and a requestId string), action=network_detail for full details of a single request by numeric id, action=network_clear to clear all recorded requests, action=networkDetails for full request/response headers and bodies of one request (requestFilePath/responseFilePath save bodies to files), action=networkState to simulate offline/online, action=route to mock network responses (intercept and fulfill matching requests), action=routeClear to remove all route mocks, action=storageSave to save login state (cookies + localStorage) as an encrypted file, action=storageRestore to restore login state from an encrypted file, action=cookies to list session cookies (values masked by default), action=cookieDelete to remove one cookie, action=dialog to list and respond to pending JavaScript dialogs (alert/confirm/prompt), or action=open to open Electron DevTools for the page.".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "instanceId": {
                            "type": "string",
                            "description": "Optional browser instance ID. Omit it or use current to target the most recently focused embedded browser tab."
                        },
                        "action": {
                            "type": "string",
                            "enum": ["snapshot", "console", "console_message", "open", "network", "network_detail", "network_clear", "networkDetails", "networkState", "route", "routeClear", "storageSave", "storageRestore", "cookies", "cookieDelete", "ax", "trace", "dialog"],
                            "description": "Developer tools action (default snapshot).",
                            "default": "snapshot"
                        },
                        "durationMs": {
                            "type": "number",
                            "description": "Trace recording duration in milliseconds (trace action only, default 3000, range 1000-30000).",
                            "default": 3000,
                            "minimum": 1000,
                            "maximum": 30000
                        },
                        "verbose": {
                            "type": "boolean",
                            "description": "Include all accessibility nodes and input values (ax action only, default false = interactive/structural roles only).",
                            "default": false
                        },
                        "maxNodes": {
                            "type": "number",
                            "description": "Maximum accessibility tree nodes to return (ax action only, default 200, range 1-1000).",
                            "default": 200,
                            "minimum": 1,
                            "maximum": 1000
                        },
                        "clearConsole": {
                            "type": "boolean",
                            "description": "Clear captured console messages after returning them (console action only).",
                            "default": false
                        },
                        "level": {
                            "type": "string",
                            "enum": ["verbose", "info", "warning", "error"],
                            "description": "Minimum console level to return (console action only). Each level includes more severe levels. Defaults to info."
                        },
                        "filter": {
                            "type": "string",
                            "description": "Only return network requests whose URL matches this regexp (network action only)."
                        },
                        "static": {
                            "type": "boolean",
                            "description": "Whether to include successful static resources (images, fonts, scripts, stylesheets) in network listing (default false).",
                            "default": false
                        },
                        "limit": {
                            "type": "number",
                            "description": "Maximum number of network requests to return (network action only, default 50, range 1-200).",
                            "default": 50,
                            "minimum": 1,
                            "maximum": 200
                        },
                        "pageIdx": {
                            "type": "number",
                            "description": "Zero-based page index for console/network listings (default 0).",
                            "minimum": 0,
                            "maximum": 1000
                        },
                        "pageSize": {
                            "type": "number",
                            "description": "Page size for console/network listings (when omitted all records are returned, up to 1000).",
                            "minimum": 1,
                            "maximum": 1000
                        },
                        "includePreserved": {
                            "type": "boolean",
                            "description": "Include records preserved from the previous navigations (console/network actions; keeps the last 3 navigations).",
                            "default": false
                        },
                        "types": {
                            "type": "array",
                            "items": { "type": "string" },
                            "description": "Only return console messages whose type/kind matches one of these values (console action only), e.g. [\"error\", \"warning\"]."
                        },
                        "resourceTypes": {
                            "type": "array",
                            "items": { "type": "string" },
                            "description": "Only return network requests of these resource types (network action only), e.g. [\"XHR\", \"Fetch\", \"Document\"]."
                        },
                        "msgid": {
                            "type": "number",
                            "description": "Numeric id of the console message to retrieve (console_message action only; use action=console to obtain ids)."
                        },
                        "requestId": {
                            "type": "string",
                            "description": "Network request reference. For networkDetails: CDP request id from the network list (string). For network_detail: the numeric id of the request to retrieve full details for (use network action first to obtain ids)."
                        },
                        "maxBodyBytes": {
                            "type": "number",
                            "description": "Maximum request/response body bytes to return (networkDetails action only, default 131072, range 1024-1048576).",
                            "default": 131072,
                            "minimum": 1024,
                            "maximum": 1048576
                        },
                        "requestFilePath": {
                            "type": "string",
                            "description": "Absolute path to save the request body to (networkDetails action only; body is written to the file instead of being returned)."
                        },
                        "responseFilePath": {
                            "type": "string",
                            "description": "Absolute path to save the response body to (networkDetails action only; body is written to the file instead of being returned)."
                        },
                        "state": {
                            "type": "string",
                            "enum": ["online", "offline"],
                            "description": "Network state to simulate (networkState action only): offline makes all network requests fail, online restores connectivity."
                        },
                        "pattern": {
                            "type": "string",
                            "description": "URL pattern to mock (route action only). Plain text = substring match; /regex/ = regular expression match. Example: \"/api/users\" or \"/.*\\.png\""
                        },
                        "status": {
                            "type": "number",
                            "description": "HTTP status code for the mocked response (route action only, default 200).",
                            "minimum": 100,
                            "maximum": 599
                        },
                        "body": {
                            "type": "string",
                            "description": "Response body (text or JSON string) for the mocked response (route action only)."
                        },
                        "contentType": {
                            "type": "string",
                            "description": "Content-Type header for the mocked response (route action only), e.g. \"application/json\"."
                        },
                        "headers": {
                            "type": "object",
                            "description": "Additional response headers as name-value pairs (route action only).",
                            "additionalProperties": { "type": "string" }
                        },
                        "dialogResponse": {
                            "type": "object",
                            "description": "Response for the dialog action: { accept: boolean, promptText?: string }. When provided, the most recent pending dialog is answered instead of listing dialogs.",
                            "properties": {
                                "accept": {
                                    "type": "boolean",
                                    "description": "true to accept (OK) the dialog, false to dismiss (Cancel)."
                                },
                                "promptText": {
                                    "type": "string",
                                    "description": "Text to enter for prompt dialogs."
                                }
                            },
                            "required": ["accept"]
                        },
                        "maxContentLength": {
                            "type": "number",
                            "description": "Maximum page text length for snapshot (default 20000, range 1000-100000).",
                            "default": DEFAULT_MAX_CONTENT_LENGTH,
                            "minimum": MIN_MAX_CONTENT_LENGTH,
                            "maximum": MAX_MAX_CONTENT_LENGTH
                        },
                        "fileName": {
                            "type": "string",
                            "description": "State file name for storageSave/storageRestore (letters, digits, dot, dash, underscore; max 100 chars). storageSave generates one when omitted."
                        },
                        "domain": {
                            "type": "string",
                            "description": "Cookie domain filter (cookies action only), e.g. \".github.com\"."
                        },
                        "showValues": {
                            "type": "boolean",
                            "description": "Return cookie values in plaintext (cookies action only, default false = masked). WARNING: plaintext output contains sensitive credentials.",
                            "default": false
                        },
                        "name": {
                            "type": "string",
                            "description": "Cookie name to delete (cookieDelete action only, combined with domain)."
                        }
                    }
                }),
            },
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: "wait".to_string(),
                description: "Wait for a condition on the page: fixed time, text to appear/disappear, or element (CSS selector) to appear/disappear. Inspired by Playwright's browser_wait_for. Omit instanceId to use the most recently focused browser tab.".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "instanceId": {
                            "type": "string",
                            "description": "Optional browser instance ID. Omit it or use current to target the most recently focused embedded browser tab."
                        },
                        "time": {
                            "type": "number",
                            "description": "Time to wait in milliseconds (maximum 30000). Mutually exclusive with text/textGone/selector/selectorGone.",
                            "minimum": 100,
                            "maximum": MAX_WAIT_TIME_MS
                        },
                        "text": {
                            "type": "string",
                            "description": "Text to wait for to appear on the page. Polls every 100ms until the text is found or the timeout elapses. Mutually exclusive with time."
                        },
                        "textGone": {
                            "type": "string",
                            "description": "Text to wait for to disappear from the page. Polls every 100ms until the text is gone or the timeout elapses. Mutually exclusive with time."
                        },
                        "selector": {
                            "type": "string",
                            "description": "CSS selector to wait for to exist in the DOM (e.g. after a SPA renders). Polls every 100ms until the element is found or the timeout elapses. Mutually exclusive with time."
                        },
                        "selectorGone": {
                            "type": "string",
                            "description": "CSS selector to wait for to disappear from the DOM (e.g. a loading spinner). Polls every 100ms until the element is gone or the timeout elapses. Mutually exclusive with time."
                        },
                        "timeoutMs": {
                            "type": "number",
                            "description": "Maximum time to wait for text/textGone/selector/selectorGone conditions in milliseconds (default 30000, range 1000-120000). Ignored for fixed time waits.",
                            "default": DEFAULT_TIMEOUT_MS,
                            "minimum": MIN_TIMEOUT_MS,
                            "maximum": MAX_TIMEOUT_MS
                        }
                    }
                }),
            },
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: "press_key".to_string(),
                description: "Press a keyboard key on the page. Use for shortcuts, Enter, Escape, Tab, Arrow keys, etc. Omit instanceId to use the most recently focused browser tab.".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "instanceId": {
                            "type": "string",
                            "description": "Optional browser instance ID. Omit it or use current to target the most recently focused embedded browser tab."
                        },
                        "key": {
                            "type": "string",
                            "description": "Name of the key to press (e.g. \"Enter\", \"Escape\", \"Tab\", \"ArrowLeft\", \"a\", \"F1\"). Supports key combinations with \"+\" (e.g. \"Control+a\", \"Shift+ArrowDown\")."
                        }
                    },
                    "required": ["key"]
                }),
            },
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: "hover".to_string(),
                description: "Hover over an element on the page with a real mouse move event. Target an element with a CSS selector or visible text. Omit instanceId to use the most recently focused browser tab.".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "instanceId": {
                            "type": "string",
                            "description": "Optional browser instance ID. Omit it or use current to target the most recently focused embedded browser tab."
                        },
                        "selector": {
                            "type": "string",
                            "description": "Optional CSS selector for the element to hover."
                        },
                        "text": {
                            "type": "string",
                            "description": "Optional visible text to locate when selector is not provided."
                        },
                        "exact": {
                            "type": "boolean",
                            "description": "Whether text matching must be exact (default false).",
                            "default": false
                        }
                    },
                    "anyOf": [
                        { "required": ["selector"] },
                        { "required": ["text"] }
                    ]
                }),
            },
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: "select_option".to_string(),
                description: "Select option(s) in a dropdown (<select>) element. Target the element with a CSS selector or visible text. Omit instanceId to use the most recently focused browser tab.".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "instanceId": {
                            "type": "string",
                            "description": "Optional browser instance ID. Omit it or use current to target the most recently focused embedded browser tab."
                        },
                        "selector": {
                            "type": "string",
                            "description": "Optional CSS selector for the select element."
                        },
                        "text": {
                            "type": "string",
                            "description": "Optional visible text to locate the select element when selector is not provided."
                        },
                        "exact": {
                            "type": "boolean",
                            "description": "Whether text matching must be exact (default false).",
                            "default": false
                        },
                        "values": {
                            "type": "array",
                            "items": { "type": "string" },
                            "description": "Array of option values to select. Can be a single value or multiple values for multi-select."
                        }
                    },
                    "anyOf": [
                        { "required": ["selector"] },
                        { "required": ["text"] }
                    ],
                    "required": ["values"]
                }),
            },
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: "close".to_string(),
                description: "Close an embedded browser tab and destroy its webview. Omit instanceId to close the most recently focused browser tab. Use the list tool to see available browser tabs and their IDs.".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "instanceId": {
                            "type": "string",
                            "description": "Optional browser instance ID to close. Omit it or use current to close the most recently focused browser tab."
                        }
                    }
                }),
            },
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: "focus".to_string(),
                description: "Switch to (activate) an embedded browser tab by its instance ID, bringing it to the foreground. Use the list tool to see available browser tabs and their IDs.".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "instanceId": {
                            "type": "string",
                            "description": "The browser instance ID to switch to."
                        }
                    },
                    "required": ["instanceId"]
                }),
            },
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: "list".to_string(),
                description: "List all open embedded browser tabs with their instance IDs, titles, URLs, active state and agent access flags (shared / isolated / origin). Tabs the user has not shared with the agent only expose their instanceId and a placeholder title (url is null); call browser-request_share to ask the user to share such a tab. Use this to discover available tabs before closing or switching.".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {}
                }),
            },
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: "evaluate".to_string(),
                description: "Evaluate JavaScript in an embedded browser page and return the serialized result. Provide the source via expression (inline) or sourcePath (a local file); with format=function the source is treated as a function and args are passed to it (JSON-serializable). waitForStableDom (default true) waits for the DOM to settle before evaluating; filePath saves the result JSON to a file instead of returning it. Credential/storage access (cookies, localStorage, etc.) is blocked; use browser-devtools cookies for those. Omit instanceId to use the most recently focused browser tab, including a browser opened by the user.".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "instanceId": {
                            "type": "string",
                            "description": "Optional browser instance ID. Omit it or use current to target the most recently focused embedded browser tab."
                        },
                        "expression": {
                            "type": "string",
                            "description": "JavaScript source to evaluate (e.g. \"document.title\" or an async IIFE). With format=function, a function declaration such as \"(el) => el.innerText\"."
                        },
                        "function": {
                            "type": "string",
                            "description": "Alias of expression for function-style scripts; provide only one of expression, function, or sourcePath."
                        },
                        "format": {
                            "type": "string",
                            "enum": ["script", "function"],
                            "description": "How to interpret the source: script evaluates it as-is (default); function treats it as a function declaration and applies args.",
                            "default": "script"
                        },
                        "args": {
                            "type": "array",
                            "items": {},
                            "description": "JSON-serializable arguments passed to the function when format=function."
                        },
                        "sourcePath": {
                            "type": "string",
                            "description": "Absolute path of a local JavaScript file to load as the source (mutually exclusive with expression/function)."
                        },
                        "filePath": {
                            "type": "string",
                            "description": "Optional absolute path; save the result as JSON to this file instead of returning it."
                        },
                        "waitForStableDom": {
                            "type": "boolean",
                            "description": "Wait for the DOM to settle before evaluating (default true; pass false for pure reads).",
                            "default": true
                        }
                    }
                }),
            },
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: "type".to_string(),
                description: "Type text into an editable element (or fill a form control) in an embedded browser. Target the element with a CSS selector, visible text, or an accessibility ref (uid=... from browser-devtools action=ax; same locating rules as browser-click). Supports inputs, textareas, contenteditable, checkboxes and radios (value \"true\"/\"false\") and <select> (value or label). By default the value is set at once and input/change events are fired; pass delayMs to type character by character for key handlers. Omit instanceId to use the most recently focused browser tab, including a browser opened by the user.".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "instanceId": {
                            "type": "string",
                            "description": "Optional browser instance ID. Omit it or use current to target the most recently focused embedded browser tab."
                        },
                        "selector": {
                            "type": "string",
                            "description": "Optional CSS selector for the target element."
                        },
                        "text": {
                            "type": "string",
                            "description": "Optional visible text to locate when selector is not provided."
                        },
                        "ref": {
                            "type": "string",
                            "description": "Optional accessibility ref (uid from a recent browser-devtools action=ax snapshot) for deterministic element targeting."
                        },
                        "value": {
                            "type": "string",
                            "description": "Text to type into the element. For checkbox/radio pass \"true\" to check or \"false\" to uncheck; for <select> pass the option value or label to select."
                        },
                        "submit": {
                            "type": "boolean",
                            "description": "Whether to submit the containing form after typing (default false).",
                            "default": false
                        },
                        "delayMs": {
                            "type": "number",
                            "description": "When greater than 0, type one character at a time with this delay in milliseconds (default 0 = set value at once).",
                            "default": 0,
                            "minimum": 0,
                            "maximum": 1000
                        }
                    },
                    "anyOf": [
                        { "required": ["selector"] },
                        { "required": ["text"] },
                        { "required": ["ref"] }
                    ],
                    "required": ["value"]
                }),
            },
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: "upload-file".to_string(),
                description: "Upload file(s) to a file input element. Target with a CSS selector, visible text, or accessibility ref. Files are injected directly via CDP (no file chooser dialog). Omit instanceId to use the most recently focused browser tab.".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "instanceId": {
                            "type": "string",
                            "description": "Optional browser instance ID. Omit it or use current to target the most recently focused embedded browser tab."
                        },
                        "selector": {
                            "type": "string",
                            "description": "Optional CSS selector for the file input element."
                        },
                        "text": {
                            "type": "string",
                            "description": "Optional visible text to locate when selector is not provided."
                        },
                        "ref": {
                            "type": "string",
                            "description": "Optional accessibility ref (uid from a recent browser-devtools action=ax snapshot)."
                        },
                        "files": {
                            "type": "array",
                            "items": { "type": "string" },
                            "description": "Absolute paths to the files to upload."
                        }
                    },
                    "anyOf": [
                        { "required": ["selector"] },
                        { "required": ["text"] },
                        { "required": ["ref"] }
                    ],
                    "required": ["files"]
                }),
            },
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: "drag".to_string(),
                description: "Drag an element onto another element with a real mouse input sequence (HTML5 drag-and-drop and pointer-drag widgets). Locate the source with fromSelector/fromText/fromRef and the drop target with toSelector/toText/toRef; fromFrameId/toFrameId optionally target specific frames from browser-frames. Omit instanceId to use the most recently focused browser tab.".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "instanceId": {
                            "type": "string",
                            "description": "Optional browser instance ID. Omit it or use current to target the most recently focused embedded browser tab."
                        },
                        "fromSelector": {
                            "type": "string",
                            "description": "CSS selector of the element to drag."
                        },
                        "fromText": {
                            "type": "string",
                            "description": "Visible text of the element to drag when fromSelector is not provided."
                        },
                        "fromRef": {
                            "type": "string",
                            "description": "Accessibility ref (uid from browser-devtools action=ax) of the element to drag."
                        },
                        "fromExact": {
                            "type": "boolean",
                            "description": "Whether fromText matching must be exact (default false).",
                            "default": false
                        },
                        "fromFrameId": {
                            "type": "string",
                            "description": "Optional frameId (from browser-frames) containing the source element."
                        },
                        "toSelector": {
                            "type": "string",
                            "description": "CSS selector of the drop target element."
                        },
                        "toText": {
                            "type": "string",
                            "description": "Visible text of the drop target element when toSelector is not provided."
                        },
                        "toRef": {
                            "type": "string",
                            "description": "Accessibility ref (uid from browser-devtools action=ax) of the drop target element."
                        },
                        "toExact": {
                            "type": "boolean",
                            "description": "Whether toText matching must be exact (default false).",
                            "default": false
                        },
                        "toFrameId": {
                            "type": "string",
                            "description": "Optional frameId (from browser-frames) containing the drop target element."
                        }
                    },
                    "allOf": [
                        {
                            "anyOf": [
                                { "required": ["fromSelector"] },
                                { "required": ["fromText"] },
                                { "required": ["fromRef"] }
                            ]
                        },
                        {
                            "anyOf": [
                                { "required": ["toSelector"] },
                                { "required": ["toText"] },
                                { "required": ["toRef"] }
                            ]
                        }
                    ]
                }),
            },
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: "fill_form".to_string(),
                description: "Fill multiple form elements in one call (inputs, textareas, checkboxes, radios, selects, contenteditable). Each elements entry locates its target with selector/text/ref and provides a value; checkbox/radio use \"true\"/\"false\", selects accept the option value or label, and submit=true submits the containing form. Failures are reported per element without aborting the remaining ones. Omit instanceId to use the most recently focused browser tab.".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "instanceId": {
                            "type": "string",
                            "description": "Optional browser instance ID. Omit it or use current to target the most recently focused embedded browser tab."
                        },
                        "elements": {
                            "type": "array",
                            "minItems": 1,
                            "items": {
                                "type": "object",
                                "properties": {
                                    "selector": {
                                        "type": "string",
                                        "description": "CSS selector for this element."
                                    },
                                    "text": {
                                        "type": "string",
                                        "description": "Visible text to locate this element when selector is not provided."
                                    },
                                    "ref": {
                                        "type": "string",
                                        "description": "Accessibility ref (uid from browser-devtools action=ax) for this element."
                                    },
                                    "value": {
                                        "type": "string",
                                        "description": "Value to fill. checkbox/radio: \"true\"/\"false\"; select: option value or label."
                                    },
                                    "submit": {
                                        "type": "boolean",
                                        "description": "Whether to submit the containing form after filling this element (default false).",
                                        "default": false
                                    }
                                },
                                "required": ["value"],
                                "anyOf": [
                                    { "required": ["selector"] },
                                    { "required": ["text"] },
                                    { "required": ["ref"] }
                                ]
                            },
                            "description": "Form elements to fill, applied in order."
                        }
                    },
                    "required": ["elements"]
                }),
            },
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: "back".to_string(),
                description: "Go back to the previous page in the browser history and wait for navigation. Omit instanceId to use the most recently focused browser tab.".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "instanceId": {
                            "type": "string",
                            "description": "Optional browser instance ID. Omit it or use current to target the most recently focused embedded browser tab."
                        }
                    }
                }),
            },
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: "forward".to_string(),
                description: "Go forward in the browser history and wait for navigation. Omit instanceId to use the most recently focused browser tab.".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "instanceId": {
                            "type": "string",
                            "description": "Optional browser instance ID. Omit it or use current to target the most recently focused embedded browser tab."
                        }
                    }
                }),
            },
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: "emulate".to_string(),
                description: "Emulate browser features on the target page (CDP Emulation/Network domains): color scheme, CPU throttling, geolocation, extra HTTP headers, network conditions, user agent and viewport. Pass null (or an empty string for viewport) to clear a specific override. Omit instanceId to use the most recently focused browser tab.".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "instanceId": {
                            "type": "string",
                            "description": "Optional browser instance ID. Omit it or use current to target the most recently focused embedded browser tab."
                        },
                        "colorScheme": {
                            "type": "string",
                            "enum": ["dark", "light", "auto"],
                            "description": "Emulate prefers-color-scheme; auto clears the override."
                        },
                        "cpuThrottlingRate": {
                            "type": "number",
                            "description": "CPU slowdown factor, 1 disables throttling (range 1-20).",
                            "minimum": 1,
                            "maximum": 20
                        },
                        "extraHttpHeaders": {
                            "type": "object",
                            "additionalProperties": { "type": "string" },
                            "description": "Extra HTTP headers sent with every page request; null clears them."
                        },
                        "geolocation": {
                            "type": "object",
                            "properties": {
                                "latitude": { "type": "number", "minimum": -90, "maximum": 90 },
                                "longitude": { "type": "number", "minimum": -180, "maximum": 180 },
                                "accuracy": { "type": "number", "minimum": 0 }
                            },
                            "required": ["latitude", "longitude"],
                            "description": "Geolocation override; null clears it."
                        },
                        "networkConditions": {
                            "type": "string",
                            "enum": ["Offline", "Slow 3G", "Fast 3G", "Slow 4G", "Fast 4G"],
                            "description": "Network throttling preset; null restores online."
                        },
                        "userAgent": {
                            "type": "string",
                            "description": "User agent override; an empty string clears it."
                        },
                        "viewport": {
                            "type": "string",
                            "description": "Device viewport \"<width>x<height>[x<devicePixelRatio>][,mobile][,touch][,landscape]\"; an empty string clears it."
                        }
                    }
                }),
            },
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: "resize_page".to_string(),
                description: "Resize the page viewport to the given dimensions (device metrics override). Omit instanceId to use the most recently focused browser tab.".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "instanceId": {
                            "type": "string",
                            "description": "Optional browser instance ID. Omit it or use current to target the most recently focused embedded browser tab."
                        },
                        "width": {
                            "type": "number",
                            "description": "Viewport width in pixels (50-8000).",
                            "minimum": 50,
                            "maximum": 8000
                        },
                        "height": {
                            "type": "number",
                            "description": "Viewport height in pixels (50-8000).",
                            "minimum": 50,
                            "maximum": 8000
                        }
                    },
                    "required": ["width", "height"]
                }),
            },
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: "performance_start_trace".to_string(),
                description: "Start recording a performance trace (CDP Tracing) on the target page. Navigate or reload BEFORE starting when you want to capture load performance. Stop with performance_stop_trace to receive Core Web Vitals, long tasks and actionable insights. Omit instanceId to use the most recently focused browser tab.".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "instanceId": {
                            "type": "string",
                            "description": "Optional browser instance ID. Omit it or use current to target the most recently focused embedded browser tab."
                        },
                        "categories": {
                            "type": "array",
                            "items": { "type": "string" },
                            "description": "Optional trace categories (defaults to devtools.timeline, v8.execute, blink.user_timing, loading and latencyInfo)."
                        }
                    }
                }),
            },
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: "performance_stop_trace".to_string(),
                description: "Stop the active performance trace and return Core Web Vitals (FCP/LCP/CLS/load/DCL/first response), long-task statistics and insights (long-tasks, render-blocking, lcp, cls, document-latency, third-parties). filePath optionally saves the raw trace (.json or .json.gz) for Perfetto/DevTools. Omit instanceId to use the most recently focused browser tab.".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "instanceId": {
                            "type": "string",
                            "description": "Optional browser instance ID. Omit it or use current to target the most recently focused embedded browser tab."
                        },
                        "filePath": {
                            "type": "string",
                            "description": "Optional absolute path to save the raw trace data (.json, or .json.gz for compression)."
                        }
                    }
                }),
            },
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: "performance_analyze_insight".to_string(),
                description: "Return full details of one insight from the last stopped trace: long-tasks, render-blocking, lcp, cls, document-latency or third-parties. Omit instanceId to use the most recently focused browser tab.".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "instanceId": {
                            "type": "string",
                            "description": "Optional browser instance ID. Omit it or use current to target the most recently focused embedded browser tab."
                        },
                        "insightId": {
                            "type": "string",
                            "description": "Insight id from the performance_stop_trace result."
                        }
                    },
                    "required": ["insightId"]
                }),
            },
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: "get_css_styles".to_string(),
                description: "Inspect the CSS cascade for an element: matched rules from all origins with source locations and media queries, inline style, inherited rules and computed values; overridden declarations are marked overloaded. Locate the element with selector or an accessibility ref (uid from browser-devtools action=ax). Rules are paginated (10 per page by default). Omit instanceId to use the most recently focused browser tab.".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "instanceId": {
                            "type": "string",
                            "description": "Optional browser instance ID. Omit it or use current to target the most recently focused embedded browser tab."
                        },
                        "selector": {
                            "type": "string",
                            "description": "CSS selector of the element to inspect."
                        },
                        "ref": {
                            "type": "string",
                            "description": "Accessibility ref (uid from browser-devtools action=ax) of the element to inspect."
                        },
                        "pageIdx": {
                            "type": "number",
                            "description": "Zero-based page index for the matched rules list (default 0).",
                            "minimum": 0,
                            "maximum": 1000
                        },
                        "pageSize": {
                            "type": "number",
                            "description": "Matched rules per page (default 10, range 1-100).",
                            "minimum": 1,
                            "maximum": 100
                        }
                    },
                    "anyOf": [
                        { "required": ["selector"] },
                        { "required": ["ref"] }
                    ]
                }),
            },
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: "audit".to_string(),
                description: "Audit the current page: axe-core accessibility scan (violations with impact, help and failing targets), lightweight SEO checks (title, meta description, h1, lang, viewport, canonical, Open Graph) and best-practice checks (secure context, doctype, charset, duplicate ids, image alt). Also reports the console error count. Omit instanceId to use the most recently focused browser tab.".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "instanceId": {
                            "type": "string",
                            "description": "Optional browser instance ID. Omit it or use current to target the most recently focused embedded browser tab."
                        },
                        "categories": {
                            "type": "array",
                            "items": {
                                "type": "string",
                                "enum": ["accessibility", "seo", "best-practices"]
                            },
                            "description": "Categories to run (default all three)."
                        }
                    }
                }),
            },
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: "take_heapsnapshot".to_string(),
                description: "Capture a V8 heap snapshot of the page and save it to filePath (.heapsnapshot). Analyze it with the get_heapsnapshot_* tools and compare_heapsnapshots. Omit instanceId to use the most recently focused browser tab.".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "instanceId": {
                            "type": "string",
                            "description": "Optional browser instance ID. Omit it or use current to target the most recently focused embedded browser tab."
                        },
                        "filePath": {
                            "type": "string",
                            "description": "Absolute path to save the .heapsnapshot file."
                        }
                    },
                    "required": ["filePath"]
                }),
            },
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: "get_heapsnapshot_summary".to_string(),
                description: "Summarize a .heapsnapshot file: node/edge counts, total self size, detached node count, top constructors and node types by size.".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "filePath": {
                            "type": "string",
                            "description": "Absolute path of the .heapsnapshot file."
                        },
                        "topN": {
                            "type": "number",
                            "description": "Number of constructors to list (default 30).",
                            "minimum": 1,
                            "maximum": 200
                        }
                    },
                    "required": ["filePath"]
                }),
            },
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: "query_heapsnapshot_objects".to_string(),
                description: "Query objects inside a .heapsnapshot file by constructor name (plain text substring or /regex/), node type, minimum self size and detachedness; results carry nodeIndex values for follow-up calls.".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "filePath": {
                            "type": "string",
                            "description": "Absolute path of the .heapsnapshot file."
                        },
                        "className": {
                            "type": "string",
                            "description": "Constructor name filter: substring match, or /regex/ for a regular expression."
                        },
                        "nodeType": {
                            "type": "string",
                            "description": "V8 node type filter, e.g. object, closure, string, array, code."
                        },
                        "minSelfSize": {
                            "type": "number",
                            "description": "Minimum self size in bytes.",
                            "minimum": 0
                        },
                        "isDetached": {
                            "type": "boolean",
                            "description": "Only return detached DOM nodes."
                        },
                        "sortBy": {
                            "type": "string",
                            "enum": ["selfSize", "id"],
                            "description": "Sort order (default selfSize descending)."
                        },
                        "pageIdx": {
                            "type": "number",
                            "description": "Zero-based page index (default 0).",
                            "minimum": 0
                        },
                        "pageSize": {
                            "type": "number",
                            "description": "Rows per page (default 20, maximum 200).",
                            "minimum": 1,
                            "maximum": 200
                        }
                    },
                    "required": ["filePath"]
                }),
            },
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: "get_heapsnapshot_object_details".to_string(),
                description: "Describe one object inside a .heapsnapshot file by nodeIndex (id, constructor, type, self size, edge count, detachedness, retainer count).".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "filePath": {
                            "type": "string",
                            "description": "Absolute path of the .heapsnapshot file."
                        },
                        "nodeIndex": {
                            "type": "number",
                            "description": "Node index from query/get results.",
                            "minimum": 0
                        }
                    },
                    "required": ["filePath", "nodeIndex"]
                }),
            },
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: "get_heapsnapshot_edges".to_string(),
                description: "List outgoing references (edges) of one object inside a .heapsnapshot file by nodeIndex.".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "filePath": {
                            "type": "string",
                            "description": "Absolute path of the .heapsnapshot file."
                        },
                        "nodeIndex": {
                            "type": "number",
                            "description": "Node index from query/get results.",
                            "minimum": 0
                        },
                        "limit": {
                            "type": "number",
                            "description": "Maximum edges to return (default 50, maximum 500).",
                            "minimum": 1,
                            "maximum": 500
                        }
                    },
                    "required": ["filePath", "nodeIndex"]
                }),
            },
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: "get_heapsnapshot_retainers".to_string(),
                description: "List objects retaining one object inside a .heapsnapshot file (reverse references) by nodeIndex.".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "filePath": {
                            "type": "string",
                            "description": "Absolute path of the .heapsnapshot file."
                        },
                        "nodeIndex": {
                            "type": "number",
                            "description": "Node index from query/get results.",
                            "minimum": 0
                        },
                        "limit": {
                            "type": "number",
                            "description": "Maximum retainers to return (default 50, maximum 500).",
                            "minimum": 1,
                            "maximum": 500
                        }
                    },
                    "required": ["filePath", "nodeIndex"]
                }),
            },
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: "get_heapsnapshot_retaining_paths".to_string(),
                description: "Trace retaining paths from one object inside a .heapsnapshot file towards GC roots (why is it not collected) by nodeIndex.".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "filePath": {
                            "type": "string",
                            "description": "Absolute path of the .heapsnapshot file."
                        },
                        "nodeIndex": {
                            "type": "number",
                            "description": "Node index from query/get results.",
                            "minimum": 0
                        },
                        "maxDepth": {
                            "type": "number",
                            "description": "Maximum path depth (default 6, maximum 30).",
                            "minimum": 1,
                            "maximum": 30
                        },
                        "maxPaths": {
                            "type": "number",
                            "description": "Maximum number of paths to return (default 5, maximum 20).",
                            "minimum": 1,
                            "maximum": 20
                        }
                    },
                    "required": ["filePath", "nodeIndex"]
                }),
            },
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: "get_heapsnapshot_duplicate_strings".to_string(),
                description: "List the most wasteful duplicate strings inside a .heapsnapshot file (value, occurrences, wasted bytes).".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "filePath": {
                            "type": "string",
                            "description": "Absolute path of the .heapsnapshot file."
                        },
                        "topN": {
                            "type": "number",
                            "description": "Number of entries to list (default 20, maximum 200).",
                            "minimum": 1,
                            "maximum": 200
                        }
                    },
                    "required": ["filePath"]
                }),
            },
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: "compare_heapsnapshots".to_string(),
                description: "Compare two .heapsnapshot files and report the biggest constructor growth and shrink (leak hunting between two points in time).".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "baseFilePath": {
                            "type": "string",
                            "description": "Absolute path of the earlier .heapsnapshot file."
                        },
                        "currentFilePath": {
                            "type": "string",
                            "description": "Absolute path of the later .heapsnapshot file."
                        },
                        "topN": {
                            "type": "number",
                            "description": "Entries per direction (default 30, maximum 200).",
                            "minimum": 1,
                            "maximum": 200
                        }
                    },
                    "required": ["baseFilePath", "currentFilePath"]
                }),
            },
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: "screencast_start".to_string(),
                description: "Start recording the page as a video (CDP screencast frames, combined into a MJPEG AVI on stop). Recording auto-stops at maxFrames or maxDurationMs. Stop with screencast_stop. Omit instanceId to use the most recently focused browser tab.".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "instanceId": {
                            "type": "string",
                            "description": "Optional browser instance ID. Omit it or use current to target the most recently focused embedded browser tab."
                        },
                        "filePath": {
                            "type": "string",
                            "description": "Optional absolute path for the resulting .avi file (defaults to the app recordings folder)."
                        },
                        "quality": {
                            "type": "number",
                            "description": "JPEG frame quality (default 70, range 1-100).",
                            "minimum": 1,
                            "maximum": 100
                        },
                        "maxWidth": {
                            "type": "number",
                            "description": "Optional maximum frame width in pixels.",
                            "minimum": 64,
                            "maximum": 3840
                        },
                        "maxFrames": {
                            "type": "number",
                            "description": "Frame cap before auto-stop (default 1200, maximum 6000).",
                            "minimum": 1,
                            "maximum": 6000
                        },
                        "maxDurationMs": {
                            "type": "number",
                            "description": "Duration cap before auto-stop in milliseconds (default 120000, maximum 600000).",
                            "minimum": 1000,
                            "maximum": 600000
                        }
                    }
                }),
            },
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: "screencast_stop".to_string(),
                description: "Stop the active screencast and produce the MJPEG AVI file (returns file path, frame count, duration, size and fps). Omit instanceId to use the most recently focused browser tab.".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "instanceId": {
                            "type": "string",
                            "description": "Optional browser instance ID. Omit it or use current to target the most recently focused embedded browser tab."
                        }
                    }
                }),
            },
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: "list_page_tools".to_string(),
                description: "List tools exposed by the page itself (WebMCP-style): the page registers window.__snowPageTools as an array or record of { name, description?, parameters?, run(args) }. Omit instanceId to use the most recently focused browser tab.".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "instanceId": {
                            "type": "string",
                            "description": "Optional browser instance ID. Omit it or use current to target the most recently focused embedded browser tab."
                        }
                    }
                }),
            },
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: "call_page_tool".to_string(),
                description: "Execute a page-registered tool (window.__snowPageTools) by name with JSON parameters and return its JSON-serializable result. Use list_page_tools first. Omit instanceId to use the most recently focused browser tab.".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "instanceId": {
                            "type": "string",
                            "description": "Optional browser instance ID. Omit it or use current to target the most recently focused embedded browser tab."
                        },
                        "name": {
                            "type": "string",
                            "description": "Name of the page tool to execute."
                        },
                        "params": {
                            "description": "JSON-serializable parameters passed to the tool's run(args) function."
                        }
                    },
                    "required": ["name"]
                }),
            },
            McpTool {
                server_id: SERVER_ID.to_string(),
                name: "get_tab_content".to_string(),
                description: "Extract the visible text content (document.body.innerText) of a browser tab, together with its URL and title. Useful for reading article text or page content without a screenshot. Omit instanceId to use the most recently focused browser tab.".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {
                        "instanceId": {
                            "type": "string",
                            "description": "Optional browser instance ID. Omit it or use current to target the most recently focused embedded browser tab."
                        },
                        "maxLength": {
                            "type": "number",
                            "description": "Maximum number of characters to return (default 20000, range 1000-100000).",
                            "default": DEFAULT_MAX_CONTENT_LENGTH,
                            "minimum": MIN_MAX_CONTENT_LENGTH,
                            "maximum": MAX_MAX_CONTENT_LENGTH
                        }
                    }
                }),
            },
        ];
        tools.push(McpTool {
            server_id: SERVER_ID.to_string(),
            name: "frames".to_string(),
            description: "Enumerate attached frames of an embedded browser, including cross-origin frames. Returns opaque document-scoped frameId and parentFrameId, main-frame flag and redacted URL/name. Re-enumerate after navigation or detachment; stale IDs never fall back to the main frame. Does not read cookies or authentication storage.".to_string(),
            input_schema: json!({"type": "object", "properties": {"instanceId": {"type": "string", "description": "Optional browser tab ID; omit or use current for the focused tab."}}}),
        });
        tools.push(McpTool {
            server_id: SERVER_ID.to_string(),
            name: "request_share".to_string(),
            description: "Ask the user to share a browser tab with the agent. Only tabs explicitly shared by the user (or tabs the agent created itself) can be driven by the other browser tools; this tool shows an in-app confirmation on the tab and waits for the user's answer. Returns { shared: true } when granted, or { shared: false, reason: \"denied\" | \"domain-blocked\" } when the user declined, did not answer in time, or the tab URL is excluded by the browser agent domain policy. Returns an error when browser agent access is turned off in settings. Omit instanceId to target the focused tab.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "instanceId": {
                        "type": "string",
                        "description": "Optional browser instance ID to share. Omit it or use current to target the most recently focused embedded browser tab."
                    }
                }
            }),
        });
        for tool in &mut tools {
            if matches!(tool.name.as_str(), "evaluate" | "get_tab_content" | "wait" | "click" | "type" | "fill_form" | "hover" | "select_option" | "upload-file" | "devtools") {
                tool.input_schema["properties"]["frameId"] = json!({
                    "type": "string",
                    "pattern": "^frame-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
                    "description": "Optional opaque frameId from browser-frames. Omit for the main frame. IDs are bound to this tab/document; stale IDs fail without fallback. For devtools only snapshot/ax support frameId. Frame AX never returns input values."
                });
                if matches!(tool.name.as_str(), "hover" | "select_option") {
                    tool.input_schema["properties"]["ref"] = json!({"type": "string", "description": "Optional frame AX ref; requires frameId from the same snapshot."});
                    tool.input_schema["anyOf"] = json!([{ "required": ["selector"] }, { "required": ["text"] }, { "required": ["frameId", "ref"] }]);
                }
                tool.description.push_str(" Optional frameId selects a document-scoped frame from browser-frames; stale IDs fail without fallback. Frame results and URLs are redacted.");
            }
        }
        tools
    }

    fn execute(&self, tool_name: &str, _args: &Value) -> napi::Result<Value> {
        match tool_name {
            "create" | "navigate" | "click" | "screenshot" | "devtools" | "close" | "focus"
            | "list" | "evaluate" | "type" | "fill_form" | "drag" | "wait" | "press_key"
            | "select_option" | "hover" | "upload-file" | "back"
            | "forward" | "get_tab_content" | "frames"
            | "emulate" | "resize_page" | "performance_start_trace" | "performance_stop_trace"
            | "performance_analyze_insight" | "get_css_styles" | "audit"
            | "take_heapsnapshot" | "get_heapsnapshot_summary" | "query_heapsnapshot_objects"
            | "get_heapsnapshot_object_details" | "get_heapsnapshot_edges"
            | "get_heapsnapshot_retainers" | "get_heapsnapshot_retaining_paths"
            | "get_heapsnapshot_duplicate_strings" | "compare_heapsnapshots"
            | "screencast_start" | "screencast_stop" | "list_page_tools" | "call_page_tool"
            | "request_share" => {
                Err(Error::new(
                    Status::GenericFailure,
                    "Browser tools must be executed through the asynchronous Electron command bridge"
                        .to_string(),
                ))
            }
            _ => Err(validation::unknown_tool_error(tool_name)),
        }
    }
}
