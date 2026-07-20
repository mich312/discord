import React, { useEffect, useState } from 'react';
import Seal from './Seal.jsx';
import { X, Bell, Sun, Moon, Key, ShieldCheck, Wave, Check } from './icons.jsx';

// User settings: profile, notifications, appearance, audio devices, and
// account/identity actions — the scattered chrome (theme toggle, bell,
// identity/secure) gathered into one panel, plus mic/output device pickers.
export default function Settings({
  me,
  theme,
  onTheme,
  onEnableNotifications,
  voice,
  secured,
  onShowIdentity,
  onSecure,
  onClose,
}) {
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
      setNotifMsg({ ok: true, text: 'notifications enabled for this device' });
    } catch (e) {
      setNotifMsg({ ok: false, text: e.message });
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

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="card modal settings" onClick={(e) => e.stopPropagation()}>
        <div className="dialog-head">
          <span className="dialog-glyph"><ShieldCheck /></span>
          <h1>Settings</h1>
          <button className="icon-btn dialog-close" data-testid="settings-close" title="close" onClick={onClose}>
            <X size={16} />
          </button>
        </div>

        {/* Profile */}
        <section className="settings-section">
          <h2 className="settings-label">profile</h2>
          <div className="settings-profile">
            <Seal name={me} size={40} title={me} />
            <div>
              <div className="settings-handle">{me}</div>
              <div className="fineprint muted">
                Your handle is tied to your identity key and can’t be changed.
              </div>
            </div>
          </div>
        </section>

        {/* Notifications */}
        <section className="settings-section">
          <h2 className="settings-label">notifications</h2>
          <div className="settings-row">
            <span className="settings-row-glyph"><Bell size={15} /></span>
            <div className="settings-row-body">
              <div>Push notifications</div>
              <div className="fineprint muted">
                A nudge when a message arrives while you’re offline.
              </div>
              {perm === 'denied' && (
                <div className="fineprint warn">
                  Blocked in this browser. Re-allow notifications for this site in your
                  browser settings, then try again.
                </div>
              )}
              {notifMsg && (
                <div className={`fineprint ${notifMsg.ok ? 'ok' : 'warn'}`}>{notifMsg.text}</div>
              )}
            </div>
            <button
              className="button"
              data-testid="settings-enable-notifications"
              disabled={notifBusy || perm === 'unsupported'}
              onClick={enableNotifs}
            >
              {perm === 'granted' ? (
                <>
                  <Check size={13} /> re-register
                </>
              ) : (
                'enable'
              )}
            </button>
          </div>
        </section>

        {/* Appearance */}
        <section className="settings-section">
          <h2 className="settings-label">appearance</h2>
          <div className="settings-row">
            <span className="settings-row-glyph">{theme === 'paper' ? <Sun size={15} /> : <Moon size={15} />}</span>
            <div className="settings-row-body">
              <div>Theme</div>
              <div className="fineprint muted">{theme === 'paper' ? 'paper (light)' : 'carbon (dark)'}</div>
            </div>
            <button className="button" data-testid="settings-theme" onClick={onTheme}>
              switch to {theme === 'paper' ? 'carbon' : 'paper'}
            </button>
          </div>
        </section>

        {/* Audio devices */}
        <section className="settings-section">
          <h2 className="settings-label">audio</h2>
          {needsMic && (
            <div className="settings-row">
              <span className="settings-row-glyph"><Wave size={15} /></span>
              <div className="settings-row-body fineprint muted">
                Allow microphone access to name your devices.
              </div>
              <button className="button" data-testid="settings-grant-mic" onClick={grantMic}>
                allow
              </button>
            </div>
          )}
          <label className="settings-field">
            <span>microphone</span>
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
            <span>output</span>
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
              <span className="fineprint muted">
                Output selection isn’t supported in this browser — it follows the system default.
              </span>
            )}
          </label>
          <p className="fineprint muted">
            Output changes apply immediately; a new microphone switches live if you’re in a call.
          </p>
        </section>

        {/* Account */}
        <section className="settings-section">
          <h2 className="settings-label">account &amp; identity</h2>
          <div className="settings-actions">
            <button className="button" data-testid="settings-identity" onClick={onShowIdentity}>
              <Key size={14} /> identity key
            </button>
            <button className="button" data-testid="settings-secure" onClick={onSecure}>
              <ShieldCheck size={14} /> {secured ? 'account secured' : 'secure account'}
            </button>
          </div>
          <p className="fineprint muted">
            Your identity lives only on your devices. Export the key or add a passkey/password
            so you can sign in elsewhere — the relay can never recover it for you.
          </p>
        </section>
      </div>
    </div>
  );
}
