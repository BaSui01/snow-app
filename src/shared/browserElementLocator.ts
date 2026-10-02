export const DESCRIBE_ELEMENT_SCRIPT = `
  const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
  const describe = (element) => normalize(
    element.innerText ||
    element.textContent ||
    element.getAttribute('aria-label') ||
    element.getAttribute('title')
  );`;
// 公共元素定位脚本：selector/text + shadowRoot 遍历 + 可见性/禁用检查 +
// scrollIntoView 居中。actionBody 在元素就绪后执行（可返回任意结果）。
// 被 click / type 复用，避免定位逻辑重复。
export const buildElementLocatorScript = (
  selector: string | null,
  text: string | null,
  exact: boolean,
  actionBody: string,
): string => `(async () => {
  const selector = ${JSON.stringify(selector)};
  const text = ${JSON.stringify(text)};
  const exact = ${JSON.stringify(exact)};
  const interactiveSelector = [
    'a[href]',
    'button',
    'input:not([type="hidden"])',
    'select',
    'textarea',
    'summary',
    '[role="button"]',
    '[role="link"]',
    '[role="menuitem"]',
    '[role="option"]',
    '[tabindex]:not([tabindex="-1"])',
    '[onclick]'
  ].join(',');
  ${DESCRIBE_ELEMENT_SCRIPT}
  const isVisible = (element) => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.visibility !== 'hidden' &&
      style.display !== 'none' &&
      Number(style.opacity) !== 0 &&
      rect.width > 0 &&
      rect.height > 0;
  };
  const collectRoots = (root, roots) => {
    roots.push(root);
    for (const element of root.querySelectorAll('*')) {
      if (element.shadowRoot) {
        collectRoots(element.shadowRoot, roots);
      }
    }
  };
  const roots = [];
  collectRoots(document, roots);
  let element = null;
  if (selector) {
    try {
      for (const root of roots) {
        const match = root.querySelector(selector);
        if (match) {
          element = match.closest(interactiveSelector) || match;
          break;
        }
      }
    } catch (error) {
      throw new Error('Invalid CSS selector: ' + selector);
    }
  }
  if (!element && text) {
    const expected = normalize(text);
    const candidates = roots.flatMap((root) =>
      Array.from(root.querySelectorAll(interactiveSelector))
    );
    const matches = candidates.filter((candidate) => {
      if (!isVisible(candidate) || candidate.matches(':disabled,[aria-disabled="true"]')) {
        return false;
      }
      const actual = describe(candidate);
      return exact ? actual === expected : actual.includes(expected);
    });
    element = matches.sort((left, right) => {
      const leftText = describe(left);
      const rightText = describe(right);
      const leftExact = leftText === expected ? 0 : 1;
      const rightExact = rightText === expected ? 0 : 1;
      return leftExact - rightExact || leftText.length - rightText.length;
    })[0] || null;
  }
  if (!element || !isVisible(element)) {
    throw new Error('Target element was not found or is not visible');
  }
  if (element.matches(':disabled,[aria-disabled="true"]')) {
    throw new Error('Target element is disabled');
  }
  element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  ${actionBody}
})()`;
