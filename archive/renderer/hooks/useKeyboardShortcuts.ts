import { useEffect, useCallback } from "react";
import { useLocation } from "wouter";

export interface KeyboardShortcut {
  key: string;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
  action: () => void;
  description: string;
}

/**
 * Global keyboard shortcuts hook
 */
export function useKeyboardShortcuts(shortcuts: KeyboardShortcut[]) {
  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => {
      for (const shortcut of shortcuts) {
        const ctrlMatch = shortcut.ctrl === undefined || shortcut.ctrl === (event.ctrlKey || event.metaKey);
        const shiftMatch = shortcut.shift === undefined || shortcut.shift === event.shiftKey;
        const altMatch = shortcut.alt === undefined || shortcut.alt === event.altKey;
        const keyMatch = event.key.toLowerCase() === shortcut.key.toLowerCase();

        if (ctrlMatch && shiftMatch && altMatch && keyMatch) {
          event.preventDefault();
          shortcut.action();
          break;
        }
      }
    },
    [shortcuts]
  );

  useEffect(() => {
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);
}

/**
 * Default application keyboard shortcuts
 */
export function useAppKeyboardShortcuts() {
  const [, setLocation] = useLocation();

  const shortcuts: KeyboardShortcut[] = [
    {
      key: "k",
      ctrl: true,
      action: () => {
        // Open search (you'll need to implement this)
        const searchInput = document.querySelector('[data-search-input]') as HTMLInputElement;
        if (searchInput) {
          searchInput.focus();
        }
      },
      description: "Open search",
    },
    {
      key: "n",
      ctrl: true,
      action: () => {
        // Create new case
        const newCaseButton = document.querySelector('[data-new-case]') as HTMLButtonElement;
        if (newCaseButton) {
          newCaseButton.click();
        }
      },
      description: "Create new case",
    },
    {
      key: "h",
      ctrl: true,
      action: () => {
        setLocation("/");
      },
      description: "Go to home",
    },
    {
      key: "c",
      ctrl: true,
      shift: true,
      action: () => {
        setLocation("/cases");
      },
      description: "Go to cases",
    },
    {
      key: "l",
      ctrl: true,
      shift: true,
      action: () => {
        setLocation("/lawyers");
      },
      description: "Go to lawyers",
    },
    {
      key: "/",
      ctrl: true,
      action: () => {
        // Show keyboard shortcuts help
        const helpButton = document.querySelector('[data-shortcuts-help]') as HTMLButtonElement;
        if (helpButton) {
          helpButton.click();
        }
      },
      description: "Show keyboard shortcuts",
    },
  ];

  useKeyboardShortcuts(shortcuts);

  return shortcuts;
}

/**
 * Format shortcut for display
 */
export function formatShortcut(shortcut: KeyboardShortcut): string {
  const parts: string[] = [];
  
  if (shortcut.ctrl) parts.push("Ctrl");
  if (shortcut.shift) parts.push("Shift");
  if (shortcut.alt) parts.push("Alt");
  parts.push(shortcut.key.toUpperCase());
  
  return parts.join(" + ");
}

