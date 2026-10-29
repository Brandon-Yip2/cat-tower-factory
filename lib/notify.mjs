// Windows toast notifications through PowerShell (no extra modules). No-op elsewhere.
import { spawn } from 'node:child_process';

const APP_ID = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe';
const xml = (s) => String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));

export function notify(title, body, url = '') {
  if (process.platform !== 'win32' || process.env.FACTORY_NO_TOAST === '1') return;
  const launch = url ? ` activationType="protocol" launch="${xml(url)}"` : '';
  const toast = `<toast${launch}><visual><binding template="ToastGeneric"><text>${xml(title)}</text><text>${xml(body).slice(0, 240)}</text></binding></visual></toast>`;
  const script = [
    '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null',
    '[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] > $null',
    '$x = New-Object Windows.Data.Xml.Dom.XmlDocument',
    `$x.LoadXml('${toast.replace(/'/g, "''")}')`,
    `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${APP_ID}').Show([Windows.UI.Notifications.ToastNotification]::new($x))`,
  ].join('; ');
  try {
    const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script], { stdio: 'ignore', windowsHide: true, detached: true });
    p.on('error', () => {});
    p.unref();
  } catch { /* notifications are best-effort */ }
}
