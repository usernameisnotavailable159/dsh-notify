/**
 * dsh-notify host half.
 *
 * The reminder behavior is browser-only (tab flashing, sounds, mobile
 * vibration and popups). This host entry exists so the manifest has a node
 * side; it intentionally keeps zero server-side state.
 */
export const name = '@dsh-external/dsh-notify'

/** @param _ctx - host root context (unused). */
export function apply(_ctx) {}
