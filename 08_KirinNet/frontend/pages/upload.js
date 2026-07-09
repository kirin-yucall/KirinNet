import { useState } from 'react';

const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000/api/v1';

const CATEGORIES = ['video', 'article', 'audio', 'image', 'other'];
const STORAGE_TYPES = ['ipfs', 'arweave'];

export default function Upload() {
  const [form, setForm] = useState({
    title: '',
    description: '',
    cid: '',
    storage_type: 'ipfs',
    category: 'video',
    tags: '',
    creator_domain: '',
    signature: '',
  });
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState(null);
  const [error, setError] = useState(null);

  const handleChange = (e) => {
    setForm({ ...form, [e.target.name]: e.target.value });
  };

  const handleGenerateCID = () => {
    // Simulate IPFS upload by generating a random CID-like string (dev only)
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let cid = 'Qm';
    for (let i = 0; i < 44; i++) {
      cid += chars[Math.floor(Math.random() * chars.length)];
    }
    setForm({ ...form, cid });
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    setSuccess(null);

    // Build payload matching api_contract.md §2
    const tags = form.tags
      ? form.tags.split(',').map(t => t.trim()).filter(Boolean).slice(0, 10)
      : [];

    const payload = {
      title: form.title,
      description: form.description || undefined,
      cid: form.cid,
      storage_type: form.storage_type,
      category: form.category,
      tags,
      creator_domain: form.creator_domain,
      signature: form.signature,
    };

    try {
      const res = await fetch(`${API_BASE}/publish`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.message || 'Publish failed');
      }

      setSuccess(data);
      setForm({
        title: '',
        description: '',
        cid: '',
        storage_type: 'ipfs',
        category: 'video',
        tags: '',
        creator_domain: '',
        signature: '',
      });
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-950 text-white">
      {/* Header */}
      <header className="border-b border-gray-800 px-6 py-4">
        <div className="max-w-2xl mx-auto flex items-center justify-between">
          <a href="/" className="text-2xl font-bold text-amber-400">KirinNet</a>
          <span className="text-sm text-gray-500">Publish Content</span>
        </div>
      </header>

      <main className="max-w-2xl mx-auto mt-8 px-4 pb-16">
        <h1 className="text-2xl font-bold mb-6">Publish Content</h1>

        {success && (
          <div className="mb-6 p-4 rounded-lg bg-green-900/30 border border-green-700">
            <p className="text-green-400 font-medium">Content published successfully!</p>
            <p className="text-sm text-green-300 mt-1">Content ID: {success.content_id}</p>
            <p className="text-sm text-green-300">CID: {success.cid}</p>
            <a href={success.url} className="text-amber-400 hover:underline text-sm">
              View on KirinNet
            </a>
          </div>
        )}

        {error && (
          <div className="mb-6 p-4 rounded-lg bg-red-900/30 border border-red-700">
            <p className="text-red-400">{error}</p>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-5">
          {/* Title */}
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1">Title *</label>
            <input
              type="text" name="title" value={form.title} onChange={handleChange}
              required maxLength={200}
              className="w-full px-3 py-2 rounded-lg bg-gray-900 border border-gray-700
                         focus:border-amber-500 focus:outline-none text-white"
              placeholder="My awesome content"
            />
          </div>

          {/* Description */}
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1">Description</label>
            <textarea
              name="description" value={form.description} onChange={handleChange}
              rows={3}
              className="w-full px-3 py-2 rounded-lg bg-gray-900 border border-gray-700
                         focus:border-amber-500 focus:outline-none text-white resize-none"
              placeholder="A brief description..."
            />
          </div>

          {/* Category + Storage Type */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-1">Category *</label>
              <select
                name="category" value={form.category} onChange={handleChange}
                className="w-full px-3 py-2 rounded-lg bg-gray-900 border border-gray-700
                           focus:border-amber-500 focus:outline-none text-white"
              >
                {CATEGORIES.map(c => (
                  <option key={c} value={c}>{c.charAt(0).toUpperCase() + c.slice(1)}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-1">Storage *</label>
              <select
                name="storage_type" value={form.storage_type} onChange={handleChange}
                className="w-full px-3 py-2 rounded-lg bg-gray-900 border border-gray-700
                           focus:border-amber-500 focus:outline-none text-white"
              >
                {STORAGE_TYPES.map(t => (
                  <option key={t} value={t}>{t === 'ipfs' ? 'IPFS' : 'Arweave'}</option>
                ))}
              </select>
            </div>
          </div>

          {/* CID */}
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1">CID *</label>
            <div className="flex gap-2">
              <input
                type="text" name="cid" value={form.cid} onChange={handleChange}
                required
                className="flex-1 px-3 py-2 rounded-lg bg-gray-900 border border-gray-700
                           focus:border-amber-500 focus:outline-none text-white text-sm"
                placeholder="QmXoyp... or bafy... or Arweave tx-id"
              />
              <button
                type="button" onClick={handleGenerateCID}
                className="px-4 py-2 rounded-lg bg-gray-800 hover:bg-gray-700
                           text-sm text-amber-400 transition border border-gray-700"
              >
                Simulate
              </button>
            </div>
            <p className="text-xs text-gray-500 mt-1">
              Upload your file to IPFS or Arweave first, then paste the CID here.
              Use "Simulate" to generate a fake CID for testing.
            </p>
          </div>

          {/* Tags */}
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1">Tags</label>
            <input
              type="text" name="tags" value={form.tags} onChange={handleChange}
              className="w-full px-3 py-2 rounded-lg bg-gray-900 border border-gray-700
                         focus:border-amber-500 focus:outline-none text-white text-sm"
              placeholder="decentralized, web3, kirindns (comma-separated, max 10)"
            />
          </div>

          {/* Creator Domain */}
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1">Creator Domain *</label>
            <input
              type="text" name="creator_domain" value={form.creator_domain} onChange={handleChange}
              required
              className="w-full px-3 py-2 rounded-lg bg-gray-900 border border-gray-700
                         focus:border-amber-500 focus:outline-none text-white"
              placeholder="alice.kirinnet.org"
            />
          </div>

          {/* Signature */}
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1">Signature *</label>
            <input
              type="text" name="signature" value={form.signature} onChange={handleChange}
              required
              className="w-full px-3 py-2 rounded-lg bg-gray-900 border border-gray-700
                         focus:border-amber-500 focus:outline-none text-white text-sm"
              placeholder="0x123abc... (ECDSA signature of metadata)"
            />
            <p className="text-xs text-gray-500 mt-1">
              Sign the metadata with your private key: SHA256(title + description + cid + domain).
              In development mode, any non-empty string is accepted.
            </p>
          </div>

          {/* Submit */}
          <button
            type="submit" disabled={submitting}
            className="w-full py-3 rounded-lg bg-amber-500 hover:bg-amber-600
                       disabled:bg-gray-700 disabled:cursor-not-allowed
                       text-gray-950 font-bold transition"
          >
            {submitting ? 'Publishing...' : 'Publish to KirinNet'}
          </button>
        </form>
      </main>
    </div>
  );
}
