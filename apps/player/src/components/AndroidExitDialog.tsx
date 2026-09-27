import { useDialogFocus } from '../focus/useDialogFocus.js'
import { androidServerInfo, androidShell } from '../lib/android.js'

/** Back at the Player's root inside the Android TV app: stay, switch server, or leave. */
export function AndroidExitDialog({ onClose }: { onClose: () => void }) {
  const dialogRef = useDialogFocus<HTMLDivElement>(true, onClose)
  const server = androidServerInfo()
  return <div ref={dialogRef} className="fixed inset-0 z-[120] grid place-items-center bg-black/70" role="dialog" aria-modal="true" aria-labelledby="android-exit-title">
    <div className="player-dialog motion-dialog w-full max-w-lg rounded-2xl p-8 shadow-[var(--archivist-shadow-dialog)]">
      <h2 id="android-exit-title" className="player-secondary-title">Leave Archivist?</h2>
      {server && <p className="mt-4 text-[12.5px] leading-relaxed text-white/55">
        Connected to <span className="text-white/85">{server.name}</span> on its {server.via} address.
      </p>}
      <div className="mt-8 flex justify-end gap-3">
        <button data-dialog-initial onClick={onClose} className="player-focusable player-button">Stay</button>
        <button onClick={() => androidShell()?.switchServer()} className="player-focusable player-button">Switch server</button>
        <button onClick={() => androidShell()?.exitApp()} className="player-focusable player-button-primary">Exit</button>
      </div>
    </div>
  </div>
}
