/**
 * Accessibility Utilities
 * 
 * Helper functions for improving keyboard navigation, screen reader support,
 * and WCAG 2.1 compliance.
 */

type KeyEvent = { key: string; preventDefault(): void };

/**
 * Handle keyboard navigation for interactive elements
 * Supports Enter and Space keys for activation
 */
export function handleKeyboardActivation(
  event: KeyEvent,
  callback: () => void
) {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    callback();
  }
}

/**
 * Generate unique IDs for ARIA labeling
 */
let idCounter = 0;
export function generateId(prefix: string = "element"): string {
  return `${prefix}-${++idCounter}`;
}

/**
 * Announce message to screen readers
 * Uses ARIA live region for dynamic content updates
 */
export function announceToScreenReader(
  message: string,
  priority: "polite" | "assertive" = "polite"
) {
  const liveRegion = document.getElementById("aria-live-region");
  if (liveRegion) {
    liveRegion.setAttribute("aria-live", priority);
    liveRegion.textContent = message;
    
    // Clear after announcement
    setTimeout(() => {
      liveRegion.textContent = "";
    }, 1000);
  }
}

/**
 * Focus trap for modals and dialogs
 * Keeps focus within a container element
 */
export function createFocusTrap(containerElement: HTMLElement) {
  const focusableElements = containerElement.querySelectorAll<HTMLElement>(
    'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
  );
  
  const firstElement = focusableElements[0];
  const lastElement = focusableElements[focusableElements.length - 1];

  function handleTabKey(event: KeyboardEvent) {
    if (event.key !== "Tab") return;

    if (event.shiftKey) {
      // Shift + Tab
      if (document.activeElement === firstElement) {
        event.preventDefault();
        lastElement?.focus();
      }
    } else {
      // Tab
      if (document.activeElement === lastElement) {
        event.preventDefault();
        firstElement?.focus();
      }
    }
  }

  containerElement.addEventListener("keydown", handleTabKey);

  // Focus first element
  firstElement?.focus();

  // Return cleanup function
  return () => {
    containerElement.removeEventListener("keydown", handleTabKey);
  };
}

/**
 * Check if element is visible to screen readers
 */
export function isVisibleToScreenReader(element: HTMLElement): boolean {
  const style = window.getComputedStyle(element);
  return (
    style.display !== "none" &&
    style.visibility !== "hidden" &&
    element.getAttribute("aria-hidden") !== "true"
  );
}

/**
 * Get accessible label for an element
 * Checks aria-label, aria-labelledby, and label elements
 */
export function getAccessibleLabel(element: HTMLElement): string | null {
  // Check aria-label
  const ariaLabel = element.getAttribute("aria-label");
  if (ariaLabel) return ariaLabel;

  // Check aria-labelledby
  const labelledBy = element.getAttribute("aria-labelledby");
  if (labelledBy) {
    const labelElement = document.getElementById(labelledBy);
    if (labelElement) return labelElement.textContent;
  }

  // Check for associated label element
  if (element instanceof HTMLInputElement) {
    const labels = element.labels;
    if (labels && labels.length > 0) {
      return labels[0].textContent;
    }
  }

  return null;
}

/**
 * Skip to main content (for keyboard navigation)
 */
export function skipToMainContent() {
  const mainContent = document.getElementById("main-content") || 
                      document.querySelector("main");
  if (mainContent) {
    mainContent.setAttribute("tabindex", "-1");
    mainContent.focus();
    mainContent.removeAttribute("tabindex");
  }
}

/**
 * Keyboard shortcuts manager
 */
export class KeyboardShortcuts {
  private shortcuts: Map<string, () => void> = new Map();

  register(key: string, callback: () => void, modifiers?: {
    ctrl?: boolean;
    alt?: boolean;
    shift?: boolean;
  }) {
    const shortcutKey = this.createShortcutKey(key, modifiers);
    this.shortcuts.set(shortcutKey, callback);
  }

  unregister(key: string, modifiers?: {
    ctrl?: boolean;
    alt?: boolean;
    shift?: boolean;
  }) {
    const shortcutKey = this.createShortcutKey(key, modifiers);
    this.shortcuts.delete(shortcutKey);
  }

  handleKeyDown = (event: KeyboardEvent) => {
    const shortcutKey = this.createShortcutKey(event.key, {
      ctrl: event.ctrlKey,
      alt: event.altKey,
      shift: event.shiftKey,
    });

    const callback = this.shortcuts.get(shortcutKey);
    if (callback) {
      event.preventDefault();
      callback();
    }
  };

  private createShortcutKey(key: string, modifiers?: {
    ctrl?: boolean;
    alt?: boolean;
    shift?: boolean;
  }): string {
    const parts: string[] = [];
    if (modifiers?.ctrl) parts.push("ctrl");
    if (modifiers?.alt) parts.push("alt");
    if (modifiers?.shift) parts.push("shift");
    parts.push(key.toLowerCase());
    return parts.join("+");
  }

  enable() {
    document.addEventListener("keydown", this.handleKeyDown);
  }

  disable() {
    document.removeEventListener("keydown", this.handleKeyDown);
  }
}

/**
 * Color contrast checker (WCAG 2.1 AA compliance)
 * Returns true if contrast ratio is at least 4.5:1 for normal text
 */
export function hasGoodContrast(
  foreground: string,
  background: string,
  largeText: boolean = false
): boolean {
  const ratio = calculateContrastRatio(foreground, background);
  const minimumRatio = largeText ? 3 : 4.5;
  return ratio >= minimumRatio;
}

function calculateContrastRatio(color1: string, color2: string): number {
  const lum1 = getRelativeLuminance(color1);
  const lum2 = getRelativeLuminance(color2);
  if (lum1 === null || lum2 === null) return 0;
  const lighter = Math.max(lum1, lum2);
  const darker = Math.min(lum1, lum2);
  return (lighter + 0.05) / (darker + 0.05);
}

function getRelativeLuminance(color: string): number | null {
  // WCAG 2.1 sRGB luminance conversion for six-digit hexadecimal colors.
  const rgb = hexToRgb(color);
  if (!rgb) return null;

  const [r, g, b] = [rgb.r, rgb.g, rgb.b].map((val) => {
    val = val / 255;
    return val <= 0.03928 ? val / 12.92 : Math.pow((val + 0.055) / 1.055, 2.4);
  });

  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result
    ? {
        r: parseInt(result[1], 16),
        g: parseInt(result[2], 16),
        b: parseInt(result[3], 16),
      }
    : null;
}

