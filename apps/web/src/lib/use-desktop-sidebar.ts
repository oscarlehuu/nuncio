import { useCallback, useRef, useState } from 'react';

const HOVER_CLOSE_DELAY_MS = 180;

export function useDesktopSidebar() {
  const [pinned, setPinned] = useState(false);
  const [hovered, setHovered] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const open = pinned || hovered;

  const clearCloseTimer = useCallback(() => {
    if (closeTimer.current !== null) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  }, []);

  const openHover = useCallback(() => {
    if (pinned) return;
    clearCloseTimer();
    setHovered(true);
  }, [pinned, clearCloseTimer]);

  const scheduleCloseHover = useCallback(() => {
    if (pinned) return;
    clearCloseTimer();
    closeTimer.current = setTimeout(() => {
      setHovered(false);
      closeTimer.current = null;
    }, HOVER_CLOSE_DELAY_MS);
  }, [pinned, clearCloseTimer]);

  const togglePin = useCallback(() => {
    clearCloseTimer();
    setPinned((current) => {
      if (current) setHovered(false);
      return !current;
    });
  }, [clearCloseTimer]);

  const closeHover = useCallback(() => {
    if (pinned) return;
    clearCloseTimer();
    setHovered(false);
  }, [pinned, clearCloseTimer]);

  return {
    pinned,
    hovered,
    open,
    openHover,
    scheduleCloseHover,
    togglePin,
    closeHover,
  };
}
