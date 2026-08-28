// Types for `python-code.mjs`, which stays JavaScript because the checks that import it are plain
// Node scripts run straight from source with no build step.

/**
 * Every token of `file` except its comments and docstrings, joined by spaces.
 *
 * @param file Absolute path to a Python file.
 */
export function codeOf(file: string): string;
