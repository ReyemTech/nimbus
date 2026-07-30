/**
 * Command execution primitives for `nimbus migrate`.
 *
 * Every external call the migrate command makes goes through {@link runCommand},
 * which always uses `execFileSync` with an argument array — never a
 * shell-interpolated string — and never throws. Callers get back a discriminated
 * result instead, so a missing tool, an unreachable cluster, or a non-zero exit
 * code can be turned into a clear WARN/FAIL instead of an unhandled exception.
 *
 * @module cli/migrate-exec
 */

import { execFileSync } from "child_process";

/** Successful command execution. */
export interface ICommandSuccess {
  readonly ok: true;
  readonly stdout: string;
}

/** Failed command execution, with enough detail to explain why to the operator. */
export interface ICommandFailure {
  readonly ok: false;
  readonly reason: "not-found" | "error";
  readonly message: string;
  readonly exitCode?: number;
}

/** Outcome of {@link runCommand}: either captured stdout, or a structured failure. */
export type CommandResult = ICommandSuccess | ICommandFailure;

/**
 * Narrow an unknown thrown value to a Node.js errno exception.
 *
 * @param error - Value caught from a try/catch block
 * @returns True when the value looks like a Node.js system error
 */
function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error;
}

/**
 * Extract the numeric exit code from an `execFileSync` failure, if present.
 *
 * @param error - Value caught from a try/catch block
 * @returns The process exit code, or undefined when unavailable
 */
function extractExitCode(error: unknown): number | undefined {
  if (error && typeof error === "object" && "status" in error) {
    const status = (error as { status: unknown }).status;
    return typeof status === "number" ? status : undefined;
  }
  return undefined;
}

/**
 * Extract a human-readable message from an `execFileSync` failure, preferring
 * captured stderr over the generic Error message.
 *
 * @param error - Value caught from a try/catch block
 * @returns A trimmed, human-readable error message
 */
function extractErrorMessage(error: unknown): string {
  if (error && typeof error === "object") {
    const withStreams = error as { stderr?: unknown; message?: unknown };
    if (typeof withStreams.stderr === "string" && withStreams.stderr.trim().length > 0) {
      return withStreams.stderr.trim();
    }
    if (Buffer.isBuffer(withStreams.stderr) && withStreams.stderr.length > 0) {
      return withStreams.stderr.toString("utf8").trim();
    }
    if (typeof withStreams.message === "string") {
      return withStreams.message;
    }
  }
  return String(error);
}

/**
 * Run a command and capture its outcome without ever throwing.
 *
 * Uses `execFileSync` with an argument array (never a shell-interpolated
 * string) so nothing in cluster or filesystem output can be interpreted as a
 * shell command.
 *
 * @param cmd - Executable to run
 * @param args - Arguments, passed verbatim (no shell involved)
 * @returns The command's stdout on success, or a structured failure reason
 */
export function runCommand(cmd: string, args: readonly string[]): CommandResult {
  try {
    const stdout = execFileSync(cmd, [...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, stdout };
  } catch (error: unknown) {
    if (isErrnoException(error) && error.code === "ENOENT") {
      return { ok: false, reason: "not-found", message: `"${cmd}" was not found on PATH.` };
    }
    return {
      ok: false,
      reason: "error",
      message: extractErrorMessage(error),
      exitCode: extractExitCode(error),
    };
  }
}

/**
 * Split raw command stdout into trimmed, non-empty lines.
 *
 * @param stdout - Raw command output
 * @returns Trimmed, non-empty lines
 */
export function splitNonEmptyLines(stdout: string): string[] {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}
