export const INSTALLER_QUIT_ARGUMENT = "--quit-for-update";

export const isInstallerQuitRequest = (
  platform: NodeJS.Platform,
  argv: readonly string[],
): boolean => platform === "win32" && argv.includes(INSTALLER_QUIT_ARGUMENT);
