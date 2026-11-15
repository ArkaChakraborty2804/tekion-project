'use client';
/** Guardrailed, versioned rule tuning. Drafts and previews here; publishing is API-only (group admin). */
import { FlaskConical, Lock, Save } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useLoad, useStaff } from './context';
import { Card, CardHeader, DataTable, Loading, OPP_LABEL, PageTitle, Pill, btn, fmtDateTime, textarea } from '../ui/kit';

export default function Rules() {
  const { api, toast, me } = useStaff();
  const { data: r, error } = useLoad(() => api('/api/rules'));
  const [editor, setEditor] = useState('');
  const [out, setOut] = useState<{ counts?: Record<string, number>; ownershipsEvaluated?: number; error?: string; id?: string } | null>(null);
  useEffect(() => { if (r) setEditor(JSON.stringify(r.published.rules, null, 2)); }, [r]);
  if (!r) return <Loading error={error} />;
  const canEdit = me.can.includes('rules_edit');
  const parse = () => { try { return JSON.parse(editor); } catch { throw new Error('Rules JSON is not valid'); } };
  const fail = (e: unknown) => setOut({ error: (e as Error).message });
  const preview = async () => { try { setOut(await api('/api/rules/preview', { method: 'POST', body: { rules: parse() } })); } catch (e) { fail(e); } };
  const save = async () => { try { const d = await api('/api/rules', { method: 'POST', body: { rules: parse() } }); toast('Draft saved'); setOut(d); } catch (e) { fail(e); } };

  return (
    <div className="space-y-6">
      <PageTitle title={`Journey rules · published v${r.published.version}`}
        subtitle="Dealers tune intervals, windows and ticket values within guardrails. The frequency cap, P1 safety handling and consent checks are not configurable." />
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        <Card className="lg:col-span-7 p-5 sm:p-6">
          <CardHeader title="Rule table" subtitle="Versioned JSON. Saving creates a draft; nothing changes until a group admin publishes." className="mb-4"
            right={canEdit ? <>
              <button type="button" className={btn.secondary} onClick={preview}><FlaskConical className="w-3.5 h-3.5" />Preview impact</button>
              <button type="button" className={btn.primary} onClick={save}><Save className="w-3.5 h-3.5" />Save draft</button>
            </> : <Pill tone="amber"><Lock className="w-3 h-3" />Read only</Pill>} />
          <textarea aria-label="Rules JSON" value={editor} onChange={(e) => setEditor(e.target.value)} rows={22} readOnly={!canEdit} className={`${textarea} font-mono-tabular leading-relaxed`} />
        </Card>
        <div className="lg:col-span-5 space-y-6">
          <Card className="p-5 sm:p-6">
            <CardHeader title="Dry run" subtitle="Candidate messages per journey step under the edited rules (nothing is persisted)" className="mb-4" />
            {!out ? <p className="text-xs text-slate-500">Run “Preview impact” to see how many customers each step would reach.</p>
              : out.error ? <p className="text-xs text-rose-600 dark:text-rose-400">{out.error}</p>
              : out.counts ? (
                <ul className="space-y-2">
                  {Object.entries(out.counts).map(([k, n]) => (
                    <li key={k} className="flex items-center justify-between text-xs"><span className="text-slate-700 dark:text-slate-300">{OPP_LABEL[k] ?? k}</span><span className="font-mono-tabular font-semibold">{n}</span></li>
                  ))}
                  <li className="pt-2 border-t border-slate-100 dark:border-white/5 text-[11px] text-slate-500">{out.ownershipsEvaluated} ownerships evaluated</li>
                </ul>
              ) : <p className="text-xs text-emerald-600 dark:text-emerald-400">Draft saved ({out.id}).</p>}
          </Card>
          <Card className="overflow-hidden">
            <div className="p-5 border-b border-slate-100 dark:border-white/5"><CardHeader title="Versions" subtitle="Publish: POST /api/rules/:id/publish (group admin)" /></div>
            <DataTable head={['Version', 'Status', 'By', 'Created']}
              rows={r.versions.map((v: any) => [`v${v.version}`, <Pill key="s" tone={v.status === 'published' ? 'emerald' : v.status === 'draft' ? 'blue' : 'slate'}>{v.status}</Pill>, v.created_by, fmtDateTime(v.created_at)])} />
          </Card>
        </div>
      </div>
    </div>
  );
}
