import type {
  WorkspaceDirectoryKind,
  WorkspaceDirectoryRecord,
} from "../../../../preload";

const splitPathSegments = (path: string): string[] =>
  path.trim().split(/[\\/]/).filter(Boolean);

export const getAutoDirectoryName = (
  kind: WorkspaceDirectoryKind,
  path: string,
): string => {
  const trimmedPath = path.trim();

  if (kind === "ssh") {
    return trimmedPath.replace(/^ssh:\/\//, "") || trimmedPath;
  }

  return splitPathSegments(trimmedPath).pop() || trimmedPath;
};

const MAX_DISAMBIGUATION_DEPTH = 3;

export const buildDirectoryDisplayNames = (
  directories: WorkspaceDirectoryRecord[],
): Map<string, string> => {
  const displayNames = new Map<string, string>();
  const usedLabels = new Set<string>();
  const autoNamedDirectories: WorkspaceDirectoryRecord[] = [];

  for (const directory of directories) {
    if (
      directory.name === getAutoDirectoryName(directory.kind, directory.path)
    ) {
      autoNamedDirectories.push(directory);
    } else {
      displayNames.set(directory.directoryId, directory.name);
      usedLabels.add(directory.name);
    }
  }

  const groups = new Map<string, WorkspaceDirectoryRecord[]>();
  for (const directory of autoNamedDirectories) {
    const group = groups.get(directory.name) ?? [];
    group.push(directory);
    groups.set(directory.name, group);
  }

  for (const group of groups.values()) {
    if (group.length < 2) {
      for (const directory of group) {
        displayNames.set(directory.directoryId, directory.name);
        usedLabels.add(directory.name);
      }
      continue;
    }

    for (const directory of group) {
      const segments = splitPathSegments(directory.path);
      const separator = directory.path.includes("\\") ? "\\" : "/";
      let label = "";

      for (
        let depth = 1;
        depth <= MAX_DISAMBIGUATION_DEPTH && !label;
        depth += 1
      ) {
        const tail = segments.slice(-depth - 1);
        if (tail.length < 2) {
          continue;
        }
        const candidate = tail.join(separator);
        if (!usedLabels.has(candidate)) {
          label = candidate;
        }
      }

      if (!label) {
        label = directory.path;
      }
      displayNames.set(directory.directoryId, label);
      usedLabels.add(label);
    }
  }

  return displayNames;
};
