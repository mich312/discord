import { useDialog } from '../lib/useDialog.js';
import React, { useEffect, useState } from 'react';
import Seal from './Seal.jsx';
import { X, Bell, Sun, Moon, Key, ShieldCheck, Wave, Check, LogOut } from './icons.jsx';
import { cx } from '../lib/cx.js';
import { failText } from '../lib/fail-text.js';

// Theme choices: [testid key, label, stored preference (null = system)].
const THEME_OPTIONS = [
  ['system', 'System', null],
  ['light', 'Light', 'paper'],
  ['dark', 'Dark', 'carbon'],
];

// User settings: profile, notifications, appearance, audio devices, and
// account/identity actions — the scattered chrome (theme toggle, bell,
// identity/secure) gathered into one panel, plus mic/output device pickers.
export default function Settings({
  me,
  theme,
  // 'paper' | 'carbon' | null, where null means the theme is following the
  // operating system. `theme` above is the resolved one either way.
  themePref = null,
  onThemePref,
  onEnableNotifications,
  voice,
  // Device preference: route my media through TURN so peers never see my
  // address. `turnAvailable` is whether the relay actually offers one.
  relayOnly = false,
  turnAvailable = false,
  onRelayOnly,
  secured,
  onLogout,
  onShowIdentity,
  onSecure,
  onClose,
}) {
  // Escape closes, like every other overlay in the app.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const [perm, setPerm] = useState(
    typeof Notification !== 'undefined' ? Notification.permission : 'unsupported'
  );
  const [notifBusy, setNotifBusy] = useState(false);
  const [notifMsg, setNotifMsg] = useState(null);

  const [inputs, setInputs] = useState([]);
  const [outputs, setOutputs] = useState([]);
  const [inputId, setInputId] = useState(voice?.inputDeviceId || '');
  const [outputId, setOutputId] = useState(voice?.outputDeviceId || '');
  const [needsMic, setNeedsMic] = useState(false);
  const [processing, setProcessing] = useState({
    echoCancellation: voice?.processing?.echoCancellation ?? true,
    noiseSuppression: voice?.processing?.noiseSuppression ?? true,
    autoGainControl: voice?.processing?.autoGainControl ?? true,
  });
  const [callSounds, setCallSounds] = useState(voice?.callSounds ?? true);
  const sinkSupported =
    typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype;

  async function loadDevices() {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    const devices = await navigator.mediaDevices.enumerateDevices();
    const ins = devices.filter((d) => d.kind === 'audioinput');
    const outs = devices.filter((d) => d.kind === 'audiooutput');
    setInputs(ins);
    setOutputs(outs);
    // Labels are blank until the site has been granted mic access once.
    setNeedsMic(ins.length > 0 && ins.every((d) => !d.label));
  }

  useEffect(() => {
    loadDevices();
    navigator.mediaDevices?.addEventListener?.('devicechange', loadDevices);
    return () => navigator.mediaDevices?.removeEventListener?.('devicechange', loadDevices);
  }, []);

  async function grantMic() {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      s.getTracks().forEach((t) => t.stop());
      await loadDevices();
    } catch {
      /* denied — labels stay blank */
    }
  }

  async function enableNotifs() {
    setNotifBusy(true);
    setNotifMsg(null);
    try {
      await onEnableNotifications();
      setPerm(typeof Notification !== 'undefined' ? Notification.permission : 'unsupported');
      setNotifMsg({ ok: true, text: 'Notifications on' });
    } catch (e) {
      setNotifMsg({ ok: false, text: failText(e, 'Couldn’t turn on notifications.') });
      setPerm(typeof Notification !== 'undefined' ? Notification.permission : 'unsupported');
    } finally {
      setNotifBusy(false);
    }
  }

  function chooseInput(id) {
    setInputId(id);
    voice?.setInputDevice?.(id || null);
  }
  function chooseOutput(id) {
    setOutputId(id);
    voice?.setOutputDevice?.(id || null);
  }
  function toggleProcessing(key) {
    const next = { ...processing, [key]: !processing[key] };
    setProcessing(next);
    voice?.setAudioProcessing?.({ [key]: next[key] });
  }
  function toggleCallSounds() {
    const next = !callSounds;
    setCallSounds(next);
    voice?.setCallSounds?.(next);
  }

  const dspOptions = [
    ['noiseSuppression', 'Noise suppression'],
    ['echoCancellation', 'Echo cancellation'],
    ['autoGainControl', 'Auto volume'],
  ];

  const dialog = useDialog(onClose, { label: 'Settings' });

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="card modal settings"
        ref={dialog.ref}
        {...dialog.props}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="dialog-head">
          <h1>Settings</h1>
          <button className="icon-btn dialog-close" data-testid="settings-close" aria-label="Close" title="Close" onClick={onClose}>
            <X size={18} />
          </button>
        </div>

        {/* Profile */}
        <section className="settings-section">
          <h2 className="settings-label">Profile</h2>
          <div className="settings-profile">
            <Seal name={me} size={40} title={me} />
            <div className="settings-handle">{me}</div>
          </div>
        </section>

        {/* Notifications */}
        <section className="settings-section">
          <h2 className="settings-label">Notifications</h2>
          <div className="settings-row">
            <span className="settings-row-glyph"><Bell size={14} /></span>
            <div className="settings-row-body">
              <div>Push notifications</div>
              {perm === 'denied' && (
                <div className="fineprint warn">
                  Blocked. Allow notifications for this site in browser settings.
                </div>
              )}
              {notifMsg && (
                <div className={`fineprint ${notifMsg.ok ? 'ok' : 'warn'}`}>{notifMsg.text}</div>
              )}
            </div>
            <button
              className="button"
              data-testid="settings-enable-notifications"
              disabled={notifBusy || perm === 'unsupported' || perm === 'denied'}
              onClick={enableNotifs}
            >
              {perm === 'granted' ? (
                <>
                  <Check size={14} /> Refresh
                </>
              ) : (
                'Turn on'
              )}
            </button>
          </div>
        </section>

        {/* Appearance */}
        <section className="settings-section">
          <h2 className="settings-label">Appearance</h2>
          <div className="settings-row">
            <span className="settings-row-glyph">{theme === 'paper' ? <Sun size={14} /> : <Moon size={14} />}</span>
            <div className="settings-row-body" id="settings-theme-label">Theme</div>
            {/* One three-way control; the filled option is the state. */}
            <div className="segmented" role="group" aria-labelledby="settings-theme-label">
              {THEME_OPTIONS.map(([key, label, pref]) => (
                <button
                  key={key}
                  type="button"
                  className={cx('segment', themePref === pref && 'on')}
                  aria-pressed={themePref === pref}
                  data-testid={`settings-theme-${key}`}
                  onClick={() => onThemePref(pref)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        </section>

        {/* Audio devices */}
        <section className="settings-section">
          <h2 className="settings-label">Audio</h2>
          {needsMic && (
            <div className="settings-row">
              <span className="settings-row-glyph"><Wave size={14} /></span>
              <div className="settings-row-body fineprint muted">
                Allow mic access to see device names.
              </div>
              <button className="button" data-testid="settings-grant-mic" onClick={grantMic}>
                Allow
              </button>
            </div>
          )}
          <label className="settings-field">
            <span>Microphone</span>
            <select value={inputId} onChange={(e) => chooseInput(e.target.value)} data-testid="settings-mic">
              <option value="">System default</option>
              {inputs.map((d) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label || `Microphone ${d.deviceId.slice(0, 6)}`}
                </option>
              ))}
            </select>
          </label>
          <label className="settings-field">
            <span>Output</span>
            {sinkSupported ? (
              <select value={outputId} onChange={(e) => chooseOutput(e.target.value)} data-testid="settings-output">
                <option value="">System default</option>
                {outputs.map((d) => (
                  <option key={d.deviceId} value={d.deviceId}>
                    {d.label || `Output ${d.deviceId.slice(0, 6)}`}
                  </option>
                ))}
              </select>
            ) : (
              <span className="fineprint muted">Uses system default</span>
            )}
          </label>

          <div className="settings-dsp">
            <div className="settings-dsp-head">Mic processing</div>
            {dspOptions.map(([key, label]) => (
              <label className="settings-toggle" key={key}>
                <input
                  type="checkbox"
                  checked={processing[key]}
                  onChange={() => toggleProcessing(key)}
                  data-testid={`settings-dsp-${key}`}
                />
                <span className="settings-toggle-body">
                  <span className="settings-toggle-label">{label}</span>
                </span>
              </label>
            ))}
          </div>

          {/* Calls are peer-to-peer, so everyone in a call learns everyone
              else's IP address unless media goes through the relay. */}
          <div className="settings-dsp">
            <div className="settings-dsp-head">Call privacy</div>
            <label className="settings-toggle">
              <input
                type="checkbox"
                checked={relayOnly}
                onChange={() => onRelayOnly?.(!relayOnly)}
                data-testid="settings-relay-only"
              />
              <span className="settings-toggle-body">
                <span className="settings-toggle-label">Hide my IP address in calls</span>
                <span className="fineprint muted">Otherwise people in a call can see it.</span>
                <span className="fineprint muted">Applies from your next call.</span>
              </span>
            </label>
            {relayOnly && !turnAvailable && (
              // Said plainly: a privacy switch that quietly does nothing is
              // worse than one that visibly does not work.
              <p className="fineprint warn" data-testid="settings-relay-no-turn">
                This server has no call relay, so calls won&rsquo;t connect. Turn this off.
              </p>
            )}
          </div>

          <div className="settings-dsp">
            <div className="settings-dsp-head">Sounds</div>
            <label className="settings-toggle">
              <input
                type="checkbox"
                checked={callSounds}
                onChange={toggleCallSounds}
                data-testid="settings-call-sounds"
              />
              <span className="settings-toggle-body">
                <span className="settings-toggle-label">Join and leave sounds</span>
              </span>
            </label>
          </div>
        </section>

        {/* Account */}
        <section className="settings-section">
          <h2 className="settings-label">Account</h2>
          {/* The backup's state as text; the button is what you can do. */}
          <div className="settings-row">
            <span className="settings-row-glyph"><ShieldCheck size={14} /></span>
            <div className="settings-row-body">
              <div>Backup</div>
              <div className="fineprint muted">{secured ? 'Backed up' : 'Only on this device'}</div>
            </div>
            <button className="button" data-testid="settings-secure" onClick={onSecure}>
              {secured ? 'Manage' : 'Back up'}
            </button>
          </div>
          <div className="settings-actions">
            <button className="button" data-testid="settings-identity" onClick={onShowIdentity}>
              <Key size={14} /> Identity key
            </button>
          </div>
        </section>

        {/* Signing out: its own section, at the end, with nothing beside it (§7.3). */}
        <section className="settings-section">
          <h2 className="settings-label">This device</h2>
          <button className="button danger" data-testid="logout" onClick={onLogout}>
            <LogOut size={14} /> Log out
          </button>
        </section>
      </div>
    </div>
  );
}
