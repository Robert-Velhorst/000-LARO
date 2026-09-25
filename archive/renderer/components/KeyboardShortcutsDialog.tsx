import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Keyboard } from "lucide-react";
import { formatShortcut, useAppKeyboardShortcuts } from "@/hooks/useKeyboardShortcuts";

export function KeyboardShortcutsDialog() {
  const [open, setOpen] = useState(false);
  const shortcuts = useAppKeyboardShortcuts();

  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        onClick={() => setOpen(true)}
        data-shortcuts-help
        title="Keyboard Shortcuts (Ctrl + /)"
      >
        <Keyboard className="h-5 w-5" />
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Keyboard Shortcuts</DialogTitle>
            <DialogDescription>
              Use these keyboard shortcuts to navigate faster
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="grid gap-3">
              {shortcuts.map((shortcut, index) => (
                <div
                  key={index}
                  className="flex items-center justify-between p-3 rounded-lg bg-muted/50 hover:bg-muted transition-colors"
                >
                  <span className="text-sm">{shortcut.description}</span>
                  <kbd className="px-3 py-1.5 text-xs font-semibold text-foreground bg-background border border-border rounded-md shadow-sm">
                    {formatShortcut(shortcut)}
                  </kbd>
                </div>
              ))}
            </div>

            <div className="pt-4 border-t border-border">
              <p className="text-xs text-muted-foreground">
                Tip: Press <kbd className="px-2 py-1 text-xs bg-muted rounded">Ctrl + /</kbd> to toggle this dialog
              </p>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

