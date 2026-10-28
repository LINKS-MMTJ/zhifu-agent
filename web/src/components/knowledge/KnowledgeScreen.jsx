// 知识库屏幕：展示真实接入的文档 + 上传新文档（自动解析 → 切块 → 热加载）
import React, { useState } from 'react';
import { useAdmin } from '../../hooks/useAdmin.js';
import { uploadKnowledgeFile } from '../../api.js';

const FORMAT_LABEL = {
  markdown: 'MD', text: 'TXT', html: 'HTML', json: 'JSON', jsonl: 'JSONL',
  word: 'DOCX', pdf: 'PDF', excel: 'XLSX', csv: 'CSV', ppt: 'PPTX', seed: '内置',
};

const FALLBACK_EXT = ['.md', '.markdown', '.txt', '.log', '.html', '.htm', '.json', '.jsonl', '.csv', '.docx', '.pdf', '.xlsx', '.xls', '.pptx'];
// 展示用：不要把 15 个扩展名全铺出来，按主要格式列一遍就够
const FORMAT_TEXT = ['MD', 'TXT', 'HTML', 'JSON', 'CSV', 'DOCX', 'PDF', 'XLSX', 'PPTX'];

function fmtBytes(n) {
  if (!n) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function fmtSize(n) {
  if (!n) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

const STATUS_TEXT = { wait: '排队中', up: '上传并解析中…', ok: '已入库', fail: '失败' };

export default function KnowledgeScreen() {
  const { knowledge, loading, error, reload } = useAdmin();
  const [items, setItems] = useState([]);
  const [dragging, setDragging] = useState(false);

  const supported = knowledge?.supportedFormats?.length ? knowledge.supportedFormats : FALLBACK_EXT;
  const maxMb = knowledge?.maxUploadMb || 50;
  const byFormat = knowledge?.byFormat || {};
  const formats = Object.entries(byFormat).sort((a, b) => b[1].chunks - a[1].chunks);

  const patch = (id, next) => {
    setItems((prev) => prev.map((it) => (it.id === id ? { ...it, ...next } : it)));
  };

  const uploadOne = async (item) => {
    const ext = `.${(item.name.split('.').pop() || '').toLowerCase()}`;
    if (!supported.includes(ext)) {
      patch(item.id, { status: 'fail', msg: `不支持的格式（${ext}）` });
      return;
    }
    if (item.size > maxMb * 1024 * 1024) {
      patch(item.id, { status: 'fail', msg: `文件超过 ${maxMb}MB` });
      return;
    }
    patch(item.id, { status: 'up', msg: '上传并解析中…' });
    try {
      const r = await uploadKnowledgeFile(item.file);
      patch(item.id, {
        status: 'ok',
        msg: r.duplicate
          ? '文件已存在，未重复入库'
          : `已入库 ${r.chunks} 个切块 · ${r.format} · 用时 ${r.durationMs}ms`,
      });
    } catch (err) {
      patch(item.id, {
        status: 'fail',
        msg: err.status === 401 ? '需要管理令牌（在「运营」页填写）' : err.message,
      });
    }
  };

  const handleFiles = async (fileList) => {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    const queued = files.map((f) => ({
      id: `${f.name}-${f.size}-${Math.random().toString(36).slice(2, 8)}`,
      name: f.name,
      size: f.size,
      file: f,
      status: 'wait',
      msg: '排队中',
    }));
    setItems((prev) => [...queued.map(({ file, ...rest }) => rest), ...prev].slice(0, 8));

    for (const item of queued) {
      // 串行上传：服务端入库是整库原子重写，并发会互相覆盖
      await uploadOne(item);
    }
    reload();
  };

  return (
    <div className="screen page">
      <div className="page-head">
        <h2>知识库</h2>
        <button className="btn" onClick={reload}>刷新</button>
      </div>

      {knowledge && (
        <>
          <p className="hint">
            {knowledge.mode === 'index' ? '真实文档索引' : '内置种子文档（未执行入库）'} ·
            {' '}{knowledge.docs.length} 篇文档 · {knowledge.chunks} 个向量块
            {knowledge.indexBytes ? ` · 索引 ${fmtBytes(knowledge.indexBytes)}` : ''}
          </p>
          {formats.length > 0 && (
            <div className="kb-formats">
              {formats.map(([fmt, v]) => (
                <span key={fmt} className="kb-chip">
                  {FORMAT_LABEL[fmt] || fmt} · {v.files} 篇 / {v.chunks} 块
                </span>
              ))}
            </div>
          )}
        </>
      )}

      <section
        className={dragging ? 'card kb-upload dragging' : 'card kb-upload'}
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          handleFiles(e.dataTransfer.files);
        }}
      >
        <h3>上传知识文档</h3>
        <label className="dropzone">
          <input
            type="file"
            multiple
            hidden
            accept={supported.join(',')}
            onChange={(e) => { handleFiles(e.target.files); e.target.value = ''; }}
          />
          <span className="dz-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 16V4" />
              <path d="m7 9 5-5 5 5" />
              <path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
            </svg>
          </span>
          <b>点击选择文件，或把文件拖到这里</b>
          <span className="dz-hint">支持 {FORMAT_TEXT.join(' / ')}</span>
          <span className="dz-hint">单文件 ≤ {maxMb}MB · 上传后自动切块，立即参与检索</span>
        </label>

        {items.length > 0 && (
          <div className="upload-list">
            {items.map((it) => (
              <div key={it.id} className={`upload-item ${it.status}`}>
                <span className="u-name" title={it.name}>{it.name}</span>
                <span className="u-size">{fmtSize(it.size)}</span>
                <span className="u-msg">{it.msg}</span>
              </div>
            ))}
          </div>
        )}

        {error?.status === 401 && (
          <p className="hint upload-401">
            上传需要管理令牌：先到「运营」页填写 ADMIN_TOKEN，再回来上传。
          </p>
        )}
      </section>

      {loading && <p className="hint">加载中…</p>}

      <div className="doc-list">
        {knowledge?.docs.map((d) => (
          <details key={d.id} className="doc-card">
            <summary>
              <span className={`kb-badge kb-${d.format}`}>{FORMAT_LABEL[d.format] || d.format}</span>
              {' '}{d.title}
            </summary>
            <p>{d.content}</p>
          </details>
        ))}
      </div>

      {knowledge?.failures?.length > 0 && (
        <div className="kb-failures">
          <h4>解析失败 {knowledge.failures.length} 个</h4>
          {knowledge.failures.slice(0, 10).map((f) => (
            <p key={f.path} className="hint">{f.path}：{f.error}</p>
          ))}
        </div>
      )}
    </div>
  );
}
