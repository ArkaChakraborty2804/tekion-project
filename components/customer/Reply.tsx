'use client';
/** Customer reply page (capability link), TekOrbit styling. English and Spanish. Text replies and photo / sound uploads. */
import { MessageSquare, Paperclip, Send, ShieldAlert } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Card, btn, cx, textarea } from '../ui/kit';

const T = {
  en: {
    title: 'Reply to your dealer', msg: 'Your message', send: 'Send message', file: 'Add a photo or a short sound recording (optional)',
    upload: 'Upload', hint: (i: number, a: number) => `Photos up to ${i} MB, recordings up to ${a} MB.`, intro: (n: string, r: string, v: string) => `Hi ${n}, this is ${r} about your ${v}.`,
    safety: 'If your vehicle is unsafe to drive, do not drive it. Call 911 in an emergency.',
    privacy: 'We remove photo location data. Photos are kept 90 days and recordings 30 days. Reply STOP by text to opt out of messages.',
    sent: 'Thanks. Your message was sent.', uploaded: 'Thanks. Your file was received.', empty: 'Please type a message first.', nofile: 'Please choose a file first.',
    toobig: 'That file is too large.', invalid: 'This link is invalid or has expired. Please contact the dealer directly.', fail: 'Something went wrong. Please try again.',
    sending: 'Sending…', dealer: 'Your dealer',
  },
  es: {
    title: 'Responda a su concesionario', msg: 'Su mensaje', send: 'Enviar mensaje', file: 'Agregue una foto o una grabación corta de sonido (opcional)',
    upload: 'Subir', hint: (i: number, a: number) => `Fotos de hasta ${i} MB, grabaciones de hasta ${a} MB.`, intro: (n: string, r: string, v: string) => `Hola ${n}, le escribe ${r} sobre su ${v}.`,
    safety: 'Si su vehículo no es seguro, no lo conduzca. En una emergencia llame al 911.',
    privacy: 'Eliminamos la ubicación de las fotos. Las fotos se guardan 90 días y las grabaciones 30 días. Responda STOP por mensaje de texto para no recibir más mensajes.',
    sent: 'Gracias. Su mensaje fue enviado.', uploaded: 'Gracias. Recibimos su archivo.', empty: 'Escriba un mensaje primero.', nofile: 'Elija un archivo primero.',
    toobig: 'El archivo es demasiado grande.', invalid: 'Este enlace no es válido o ha caducado. Comuníquese directamente con el concesionario.', fail: 'Algo salió mal. Inténtelo de nuevo.',
    sending: 'Enviando…', dealer: 'Su concesionario',
  },
};

interface Info { firstName: string; language: 'en' | 'es'; rooftop: string; vehicle: string; maxUploadMb: { image: number; audio: number } }

export default function Reply({ token }: { token: string }) {
  const base = `/api/reply/${encodeURIComponent(token)}`;
  const [info, setInfo] = useState<Info | null>(null);
  const [invalid, setInvalid] = useState(false);
  const [text, setText] = useState('');
  const [fileName, setFileName] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ msg: string; kind: '' | 'ok' | 'err' }>({ msg: '', kind: '' });
  const [thread, setThread] = useState<Array<{ who: 'you' | 'dealer'; text: string }>>([]);
  const fileRef = useRef<HTMLInputElement>(null);
  const t = T[info?.language ?? 'en'];

  useEffect(() => {
    fetch(base).then(async (res) => {
      if (!res.ok) return setInvalid(true);
      const i = (await res.json()) as Info;
      setInfo(i);
      document.documentElement.lang = i.language;
      document.title = T[i.language].title;
    }).catch(() => setInvalid(true));
  }, [base]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setStatus({ msg: t.sending, kind: '' });
    try { await fn(); } finally { setBusy(false); }
  };

  const onMessage = (e: FormEvent) => {
    e.preventDefault();
    const body = text.trim();
    if (!body) return setStatus({ msg: t.empty, kind: 'err' });
    void run(async () => {
      const res = await fetch(`${base}/message`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: body }) }).catch(() => null);
      if (!res) return setStatus({ msg: t.fail, kind: 'err' });
      if (res.status === 404) return setStatus({ msg: t.invalid, kind: 'err' });
      if (!res.ok) return setStatus({ msg: t.fail, kind: 'err' });
      const out = await res.json();
      setStatus({ msg: t.sent, kind: 'ok' });
      setText('');
      setThread((th) => [...th, { who: 'you', text: body }, ...(out.reply ? [{ who: 'dealer' as const, text: out.reply }] : [])]);
    });
  };

  const onFile = (e: FormEvent) => {
    e.preventDefault();
    const f = fileRef.current?.files?.[0];
    if (!f || !info) return setStatus({ msg: t.nofile, kind: 'err' });
    const capMb = f.type.startsWith('audio/') ? info.maxUploadMb.audio : info.maxUploadMb.image;
    if (f.size > capMb * 1048576) return setStatus({ msg: t.toobig, kind: 'err' });
    void run(async () => {
      // Raw bytes; the server checks magic bytes and strips image metadata. The browser-declared type is not trusted.
      const res = await fetch(`${base}/media`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: f }).catch(() => null);
      if (!res) return setStatus({ msg: t.fail, kind: 'err' });
      if (res.status === 413) return setStatus({ msg: t.toobig, kind: 'err' });
      if (res.status === 404) return setStatus({ msg: t.invalid, kind: 'err' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        return setStatus({ msg: body.error ?? t.fail, kind: 'err' });
      }
      const out = await res.json().catch(() => ({}));
      setStatus({ msg: t.uploaded, kind: 'ok' });
      setThread((th) => [...th, { who: 'you', text: `📎 ${f.name}` }, ...(out.triage?.message ? [{ who: 'dealer' as const, text: out.triage.message }] : [])]);
      if (fileRef.current) fileRef.current.value = '';
      setFileName('');
    });
  };

  return (
    <div className="min-h-screen">
      <header className="h-16 px-4 sm:px-6 border-b border-slate-200 dark:border-white/10 bg-white/85 dark:bg-[#0B0F17]/90 backdrop-blur-md flex items-center gap-2.5">
        <span className="w-8 h-8 rounded-lg bg-blue-600 text-white flex items-center justify-center font-display font-bold text-sm shadow-sm">T</span>
        <span className="flex flex-col">
          <span className="text-sm font-bold tracking-tight font-display text-slate-900 dark:text-white leading-tight">{t.title}</span>
          <span className="text-[10px] font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider">{info?.rooftop ?? 'TekOrbit'}</span>
        </span>
      </header>
      <main id="main" className="max-w-xl mx-auto p-4 sm:p-6 space-y-5">
        <p className="text-sm text-slate-600 dark:text-slate-300">{invalid ? T.en.invalid : info ? t.intro(info.firstName, info.rooftop, info.vehicle) : 'Loading…'}</p>
        {info ? (
          <>
            <div className="flex items-start gap-2 rounded-xl border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/30 p-3 text-xs text-amber-800 dark:text-amber-200">
              <ShieldAlert className="w-4 h-4 shrink-0" aria-hidden="true" /><span>{t.safety}</span>
            </div>
            {thread.length ? (
              <Card className="p-4 space-y-2" aria-live="polite">
                {thread.map((m, i) => (
                  <div key={i} className={cx('flex', m.who === 'you' ? 'justify-end' : 'justify-start')}>
                    <p className={cx('max-w-[85%] text-xs leading-relaxed px-4 py-2.5 rounded-2xl whitespace-pre-wrap', m.who === 'you' ? 'bg-blue-600 text-white rounded-br-sm' : 'bg-slate-100 dark:bg-[#161D2B] text-slate-800 dark:text-slate-100 rounded-bl-sm')}>
                      {m.who === 'dealer' ? <span className="block text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-0.5">{t.dealer}</span> : null}{m.text}
                    </p>
                  </div>
                ))}
              </Card>
            ) : null}
            <Card className="p-5 space-y-4">
              <form onSubmit={onMessage} noValidate className="space-y-2">
                <label htmlFor="msg" className="flex items-center gap-1.5 text-xs font-semibold text-slate-700 dark:text-slate-200"><MessageSquare className="w-3.5 h-3.5" />{t.msg}</label>
                <textarea id="msg" rows={4} maxLength={1000} required value={text} onChange={(e) => setText(e.target.value)} className={textarea} />
                <button type="submit" disabled={busy} className={cx(btn.primary, 'w-full h-11')}><Send className="w-3.5 h-3.5" />{t.send}</button>
              </form>
              <form onSubmit={onFile} noValidate className="space-y-2 pt-4 border-t border-slate-100 dark:border-white/5">
                <span className="block text-xs font-semibold text-slate-700 dark:text-slate-200">{t.file}</span>
                <div className="flex flex-wrap items-center gap-2">
                  <label className={btn.secondary}>
                    <Paperclip className="w-3.5 h-3.5" />{fileName || 'Choose file'}
                    <input ref={fileRef} type="file" className="sr-only" onChange={(e) => setFileName(e.target.files?.[0]?.name ?? '')}
                      accept="image/jpeg,image/png,image/webp,audio/mpeg,audio/mp4,audio/wav,audio/webm,audio/ogg" />
                  </label>
                  <button type="submit" disabled={busy} className={btn.primary}>{t.upload}</button>
                </div>
                <p className="text-[11px] text-slate-500">{t.hint(info.maxUploadMb.image, info.maxUploadMb.audio)}</p>
              </form>
            </Card>
            <p className="text-[11px] text-slate-500">{t.privacy}</p>
          </>
        ) : null}
        <p role="status" aria-live="polite" className={cx('text-sm font-semibold', status.kind === 'err' ? 'text-rose-600 dark:text-rose-400' : status.kind === 'ok' ? 'text-emerald-600 dark:text-emerald-400' : 'text-slate-500')}>{status.msg}</p>
      </main>
    </div>
  );
}
