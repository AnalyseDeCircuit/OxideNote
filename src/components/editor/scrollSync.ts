/**
 * Scroll synchronization between Markdown editor and preview pane.
 *
 * Faithful adaptation of VS Code's scroll-sync algorithm
 * (extensions/markdown-language-features/preview-src/scroll-sync.ts)
 * adapted for a scrollable container element instead of window scroll.
 *
 * Key concepts:
 *  - Every block-level element in the rendered preview carries a `code-line`
 *    class and a `data-line` attribute indicating its source line number.
 *  - Scroll position is interpolated between adjacent anchored elements.
 *  - Binary search is used for offset→line lookups.
 */

const CODE_LINE_CLASS = 'code-line';

interface CodeLineElement {
  /** The visual display element (e.g. <pre> for fenced code blocks) */
  element: HTMLElement;
  /** Source line number (-1 for sentinel) */
  line: number;
}

/**
 * Collect all code-line anchored elements from the preview container.
 *
 * Follows VS Code's collection rules:
 *  - Container itself is added as line -1 sentinel
 *  - <code> inside <pre>: uses <pre> as the display element
 *  - <ul> and <ol> are skipped (first <li> child covers the same line)
 */
function getCodeLineElements(container: HTMLElement): CodeLineElement[] {
  const elements: CodeLineElement[] = [{ element: container, line: -1 }];

  for (const el of container.getElementsByClassName(CODE_LINE_CLASS)) {
    if (!(el instanceof HTMLElement)) continue;

    const line = Number(el.getAttribute('data-line'));
    if (Number.isNaN(line)) continue;

    if (el.tagName === 'CODE' && el.parentElement?.tagName === 'PRE') {
      // Fenced code blocks: the <code> carries the data-line but
      // the <pre> parent is the visual container for bounds calculation
      elements.push({ element: el.parentElement, line });
    } else if (el.tagName === 'UL' || el.tagName === 'OL') {
      // Skip list containers — first <li> child covers the same line
    } else {
      elements.push({ element: el, line });
    }
  }

  return elements;
}

/**
 * Get the effective visual bounds of a code-line element.
 *
 * If the element contains descendant code-line elements, only count
 * height from the element's top to the first descendant's top.
 * This prevents double-counting when parent blocks wrap fine-grained
 * child anchors (e.g. a wrapper div containing <li> anchors).
 *
 * Returns offsets relative to the scroll container's origin
 * (i.e. container-absolute coordinates suitable for scrollTop).
 */
function getElementBounds(
  entry: CodeLineElement,
  container: HTMLElement
): { top: number; height: number } {
  const containerRect = container.getBoundingClientRect();
  const elRect = entry.element.getBoundingClientRect();
  const top = elRect.top - containerRect.top + container.scrollTop;

  // Check for nested code-line child — clip height at child boundary
  const codeLineChild = entry.element.querySelector(`.${CODE_LINE_CLASS}`);
  if (codeLineChild) {
    const childRect = (codeLineChild as HTMLElement).getBoundingClientRect();
    return { top, height: Math.max(1, childRect.top - elRect.top) };
  }

  return { top, height: elRect.height };
}

/**
 * Find the code-line elements that bracket a given source line number.
 *
 * If an exact match is found, returns `{ previous: exact }`.
 * If the line is between two anchored elements,
 * returns `{ previous, next }`.
 */
function getElementsForSourceLine(
  container: HTMLElement,
  targetLine: number
): { previous: CodeLineElement; next?: CodeLineElement } {
  const lineNumber = Math.floor(targetLine);
  const lines = getCodeLineElements(container);
  let previous = lines[0];

  for (const entry of lines) {
    if (entry.line === lineNumber) {
      return { previous: entry, next: undefined };
    } else if (entry.line > lineNumber) {
      return { previous, next: entry };
    }
    previous = entry;
  }

  return { previous };
}

/**
 * Find the code-line elements at a given scroll offset
 * (container-absolute coordinates).
 *
 * Uses binary search over visible elements for efficiency.
 */
function getLineElementsAtPageOffset(
  container: HTMLElement,
  offset: number
): { previous: CodeLineElement; next?: CodeLineElement } {
  const allLines = getCodeLineElements(container);

  // Filter to visible elements only
  const lines = allLines.filter((entry) => {
    if (entry.element === container) return true; // sentinel always included
    return entry.element.offsetHeight > 0 && entry.element.offsetWidth > 0;
  });

  if (lines.length === 0) {
    return { previous: { element: container, line: -1 } };
  }

  // Binary search: find the first element whose bottom >= offset
  let lo = -1;
  let hi = lines.length - 1;

  while (lo + 1 < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const bounds = getElementBounds(lines[mid], container);
    if (bounds.top + bounds.height >= offset) {
      hi = mid;
    } else {
      lo = mid;
    }
  }

  const hiElement = lines[hi];
  const hiBounds = getElementBounds(hiElement, container);

  if (hi >= 1 && hiBounds.top > offset) {
    // Offset is in the gap between lo and hi elements
    return { previous: lines[lo], next: hiElement };
  }

  if (hi > 1 && hi < lines.length && hiBounds.top + hiBounds.height > offset) {
    // Offset is within the hi element
    return { previous: hiElement, next: lines[hi + 1] };
  }

  return { previous: hiElement };
}

// ═══════════════════════════════════════════════════════════════
// Public API
// ═══════════════════════════════════════════════════════════════

/**
 * Calculate the scrollTop needed to reveal a given source line
 * in the preview container.
 *
 * Replicates VS Code's `scrollToRevealSourceLine()`:
 *  - Finds the bracketing code-line elements for the target line
 *  - If between two elements, interpolates in the gap
 *    (between previousEnd and next.top)
 *  - If within a single element, uses fractional line progress
 */
export function getPreviewScrollTopForSourceLine(
  container: HTMLElement,
  line: number
): number {
  if (line <= 0) return 0;

  const { previous, next } = getElementsForSourceLine(container, line);
  const rect = getElementBounds(previous, container);
  const previousTop = rect.top;

  if (next && next.line !== previous.line) {
    // Between two elements: interpolate in the gap
    const betweenProgress =
      (line - previous.line) / (next.line - previous.line);
    const previousEnd = previousTop + rect.height;
    const nextBounds = getElementBounds(next, container);
    const betweenHeight = nextBounds.top - previousEnd;
    return previousEnd + betweenProgress * betweenHeight;
  }

  // Within element: use fractional line progress
  const progressInElement = line - Math.floor(line);
  return previousTop + rect.height * progressInElement;
}

/**
 * Calculate the source line number for a given scroll position.
 * Returns a fractional line number (e.g. 5.3 = 30% through line 5).
 *
 * Replicates VS Code's `getEditorLineNumberForPageOffset()`:
 *  - Uses binary search to find bracketing elements at the offset
 *  - Interpolates the line number from pixel position
 */
export function getSourceLineForPreviewOffset(
  container: HTMLElement,
  offset: number
): number | null {
  const { previous, next } = getLineElementsAtPageOffset(container, offset);

  if (!previous) return null;
  if (previous.line < 0) return 0;

  const previousBounds = getElementBounds(previous, container);
  const offsetFromPrevious = offset - previousBounds.top;

  if (next) {
    const nextBounds = getElementBounds(next, container);
    const totalDistance = nextBounds.top - previousBounds.top;
    if (totalDistance > 0) {
      const progressBetweenElements = offsetFromPrevious / totalDistance;
      return previous.line + progressBetweenElements * (next.line - previous.line);
    }
  }

  if (previousBounds.height > 0) {
    const progressWithinElement = offsetFromPrevious / previousBounds.height;
    return previous.line + progressWithinElement;
  }

  return previous.line;
}
