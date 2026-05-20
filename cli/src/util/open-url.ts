import { spawn } from "child_process";

/**
 * Launch the user's default browser at `url`. Resolves once the platform's
 * open command has been spawned (not when the browser actually loads the
 * page).
 *
 * Replaces the `open` npm package, which is ESM-only since v9 and can't be
 * `require()`'d from our CJS bundle.
 */
export function openUrl(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let cmd: string;
    let args: string[];
    switch (process.platform) {
      case "darwin":
        cmd = "open";
        args = [url];
        break;
      case "win32":
        cmd = "cmd";
        // The empty "" is the window title arg `start` expects when the
        // URL itself starts with a quoted token.
        args = ["/c", "start", "", url.replace(/&/g, "^&")];
        break;
      default:
        // Linux, *BSD, WSL fall back to xdg-open (which is provided by the
        // distro's freedesktop package, not by us).
        cmd = "xdg-open";
        args = [url];
    }
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.on("error", reject);
    child.unref();
    resolve();
  });
}
