import { useRef } from 'react';

/**
 * Lets a horizontal range input sit inside a vertically scrolling list.
 *
 * The cards scroll, and sliders cover most of their height, so a finger drag
 * usually starts on a slider. `touch-action: none` would hand that gesture to
 * the slider and the list would never scroll; `pan-y` alone lets it scroll but
 * a native range commits a value on pointerdown, so scrolling the list would
 * silently change a zone's brightness.
 *
 * So: `pan-y` in CSS for the scrolling, and this to decide what the gesture
 * actually was before anything reaches the server. A change is only sent once
 * the movement is clearly horizontal, or on release for a plain tap. If the
 * browser claims the gesture for scrolling it fires pointercancel, and the
 * caller puts the value back.
 *
 * State lives in a ref and is read synchronously inside event handlers, so
 * there is no re-render per pointermove and no stale-closure reading.
 */

// Horizontal travel before a drag counts as "meant for the slider". Small
// enough not to feel laggy, large enough that the initial wobble of a vertical
// swipe does not trip it.
const CONFIRM_PX = 6;

export default function useSliderGesture() {
  const gesture = useRef({ active: false, confirmed: false, x: 0, y: 0 });

  return {
    /** Pointer went down on the slider — nothing is committed yet. */
    begin(event) {
      gesture.current = { active: true, confirmed: false, x: event.clientX, y: event.clientY };
    },

    /**
     * Feed pointermove in. Returns true on the single move that promotes this
     * to a real slider drag, which is the caller's cue to flush the value the
     * finger has already scrubbed past.
     */
    track(event) {
      const state = gesture.current;
      if (!state.active || state.confirmed) return false;

      const dx = Math.abs(event.clientX - state.x);
      const dy = Math.abs(event.clientY - state.y);
      if (dx >= CONFIRM_PX && dx > dy) {
        state.confirmed = true;
        return true;
      }
      return false;
    },

    /** Released without the browser taking over: a tap counts as intentional. */
    end() {
      gesture.current.active = false;
      gesture.current.confirmed = true;
    },

    /** The browser took the gesture for scrolling. Nothing was intended here. */
    cancel() {
      gesture.current = { active: false, confirmed: false, x: 0, y: 0 };
    },

    /** Whether a change event should reach the server yet. */
    sending() {
      return !gesture.current.active || gesture.current.confirmed;
    },
  };
}
