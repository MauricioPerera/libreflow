import type { Directive } from 'vue';

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

interface TrapState {
  previouslyFocused: HTMLElement | null;
  handler: (e: KeyboardEvent) => void;
}

const states = new WeakMap<HTMLElement, TrapState>();

/**
 * `v-focus-trap` — keeps keyboard focus inside a modal while it is mounted.
 * On mount: remembers the previously focused element and focuses the first control.
 * While mounted: Tab / Shift+Tab cycle within the element.
 * On unmount: restores focus to where it was.
 */
export const focusTrap: Directive<HTMLElement> = {
  mounted(el) {
    const previouslyFocused = document.activeElement as HTMLElement | null;

    const getFocusable = (): HTMLElement[] =>
      Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        n => n.offsetParent !== null || n === document.activeElement
      );

    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const focusable = getFocusable();
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement as HTMLElement;

      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      } else if (!el.contains(active)) {
        e.preventDefault();
        first.focus();
      }
    };

    el.addEventListener('keydown', handler);
    states.set(el, { previouslyFocused, handler });

    // Focus the first control once the DOM has settled.
    requestAnimationFrame(() => {
      const focusable = getFocusable();
      if (focusable.length) focusable[0].focus();
    });
  },
  unmounted(el) {
    const state = states.get(el);
    if (state) {
      el.removeEventListener('keydown', state.handler);
      state.previouslyFocused?.focus?.();
      states.delete(el);
    }
  },
};
