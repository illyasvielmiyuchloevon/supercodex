const ANSI_SEQUENCE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

export function stripAnsi(value: string): string {
  return value.replace(ANSI_SEQUENCE, "");
}

export function displayCellWidth(value: string): number {
  let width = 0;
  for (const char of stripAnsi(value)) {
    width += charCellWidth(char);
  }
  return width;
}

export function padRightCells(value: string, width: number): string {
  const safeWidth = Math.max(0, Math.floor(width));
  const current = displayCellWidth(value);
  if (current >= safeWidth) {
    return sliceAnsiByCellWidth(value, safeWidth);
  }
  return `${value}${" ".repeat(safeWidth - current)}`;
}

export function sliceAnsiByCellWidth(value: string, width: number): string {
  const safeWidth = Math.max(0, Math.floor(width));
  if (safeWidth <= 0) {
    return value.includes("\x1b[") ? "\x1b[0m" : "";
  }

  let used = 0;
  let output = "";
  let sawAnsi = false;
  for (let index = 0; index < value.length; ) {
    if (value[index] === "\x1b" && value[index + 1] === "[") {
      const match = value.slice(index).match(/^\x1b\[[0-9;?]*[ -/]*[@-~]/);
      if (match) {
        sawAnsi = true;
        output += match[0];
        index += match[0].length;
        continue;
      }
    }

    const codePoint = value.codePointAt(index);
    if (codePoint === undefined) {
      break;
    }
    const char = String.fromCodePoint(codePoint);
    const widthForChar = charCellWidth(char);
    if (widthForChar > 0 && used + widthForChar > safeWidth) {
      break;
    }
    output += char;
    used += widthForChar;
    index += char.length;
  }
  return sawAnsi ? `${output}\x1b[0m` : output;
}

export function sliceTextByCellWidth(value: string, width: number): string {
  return sliceAnsiByCellWidth(value, width);
}

export function sliceTextEndByCellWidth(value: string, width: number): string {
  const safeWidth = Math.max(0, Math.floor(width));
  if (safeWidth <= 0) {
    return "";
  }
  const chars = Array.from(value);
  const selected: string[] = [];
  let used = 0;
  for (let index = chars.length - 1; index >= 0; index--) {
    const char = chars[index] ?? "";
    const widthForChar = charCellWidth(char);
    if (widthForChar > 0 && used + widthForChar > safeWidth) {
      break;
    }
    selected.push(char);
    used += widthForChar;
  }
  return selected.reverse().join("");
}

export function shortenByCellWidth(value: string, width: number): string {
  const safeWidth = Math.max(0, Math.floor(width));
  if (displayCellWidth(value) <= safeWidth) {
    return value;
  }
  if (safeWidth <= 3) {
    return sliceAnsiByCellWidth(value, safeWidth);
  }
  return `${sliceAnsiByCellWidth(value, safeWidth - 3)}...`;
}

export function wrapLinesByCellWidth(lines: string[], width: number): string[] {
  const safeWidth = Math.max(1, Math.floor(width));
  const result: string[] = [];
  for (const line of lines) {
    const clean = stripAnsi(line).replace(/\t/g, "  ");
    if (!clean) {
      result.push("");
      continue;
    }

    let current = "";
    let currentWidth = 0;
    for (const char of clean) {
      const widthForChar = charCellWidth(char);
      if (widthForChar > 0 && currentWidth > 0 && currentWidth + widthForChar > safeWidth) {
        result.push(current);
        current = "";
        currentWidth = 0;
      }
      current += char;
      currentWidth += widthForChar;
    }
    if (current || result.length === 0) {
      result.push(current);
    }
  }
  return result;
}

function charCellWidth(char: string): number {
  const codePoint = char.codePointAt(0);
  if (codePoint === undefined) {
    return 0;
  }
  if (codePoint === 0 || codePoint < 32 || (codePoint >= 0x7f && codePoint < 0xa0)) {
    return 0;
  }
  if (isCombining(codePoint)) {
    return 0;
  }
  return isWide(codePoint) ? 2 : 1;
}

function isCombining(codePoint: number): boolean {
  return (
    (codePoint >= 0x0300 && codePoint <= 0x036f) ||
    (codePoint >= 0x1ab0 && codePoint <= 0x1aff) ||
    (codePoint >= 0x1dc0 && codePoint <= 0x1dff) ||
    (codePoint >= 0x20d0 && codePoint <= 0x20ff) ||
    (codePoint >= 0xfe00 && codePoint <= 0xfe0f) ||
    (codePoint >= 0xfe20 && codePoint <= 0xfe2f) ||
    codePoint === 0x200d
  );
}

function isWide(codePoint: number): boolean {
  return (
    codePoint >= 0x1100 &&
    (codePoint <= 0x115f ||
      codePoint === 0x2329 ||
      codePoint === 0x232a ||
      (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
      (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
      (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
      (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
      (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
      (codePoint >= 0xff00 && codePoint <= 0xff60) ||
      (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
      (codePoint >= 0x1f300 && codePoint <= 0x1faff) ||
      (codePoint >= 0x20000 && codePoint <= 0x3fffd))
  );
}
