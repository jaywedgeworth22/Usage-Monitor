/* eslint-disable react-hooks/set-state-in-effect */
"use client";

import { useEffect, useState } from "react";

export interface Project {
  id?: string;
  name: string;
  description?: string | null;
  monthlyBudgetUsd?: number | null;
}

interface AddProjectModalProps {
  open: boolean;
  onClose: () => void;
  onSave: (project: Project) => Promise<void>;
  editProject?: Project | null;
}

function parseNumberField(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error("Must be a non-negative number");
  }
  return parsed;
}

export default function AddProjectModal({
  open,
  onClose,
  onSave,
  editProject,
}: AddProjectModalProps) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [monthlyBudgetUsd, setMonthlyBudgetUsd] = useState("");

  useEffect(() => {
    if (!open) return;
    setError("");
    setName(editProject?.name || "");
    setDescription(editProject?.description || "");
    setMonthlyBudgetUsd(
      editProject?.monthlyBudgetUsd != null
        ? String(editProject.monthlyBudgetUsd)
        : ""
    );
  }, [editProject, open]);

  if (!open) return null;

  const handleSave = async () => {
    setError("");
    setSaving(true);
    try {
      if (!name.trim()) {
        throw new Error("Project name is required");
      }

      await onSave({
        id: editProject?.id,
        name: name.trim(),
        description: description.trim() || null,
        monthlyBudgetUsd: monthlyBudgetUsd ? parseNumberField(monthlyBudgetUsd) : null,
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div
        className="fixed inset-0 bg-black/40 backdrop-blur-sm"
        onClick={onClose}
      />
      <div className="relative bg-white rounded-2xl shadow-xl max-w-md w-full mx-4 max-h-[90vh] overflow-y-auto">
        <div className="p-6">
          <div className="flex items-center justify-between mb-6">
            <h2 className="text-xl font-semibold text-gray-900">
              {editProject ? "Edit Project" : "Add Project"}
            </h2>
            <button
              onClick={onClose}
              className="text-gray-400 hover:text-gray-600 text-2xl leading-none"
            >
              &times;
            </button>
          </div>

          {error && (
            <div className="mb-4 p-3 bg-red-50 text-red-700 text-sm rounded-lg">
              {error}
            </div>
          )}

          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Name
              </label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g., Data Platform"
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Description (optional)
              </label>
              <input
                type="text"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="e.g., Core data engineering team tools"
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Monthly Budget (USD)
              </label>
              <input
                type="number"
                min="0"
                step="0.01"
                value={monthlyBudgetUsd}
                onChange={(e) => setMonthlyBudgetUsd(e.target.value)}
                placeholder="e.g., 500"
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
          </div>

          <div className="mt-6 flex items-center justify-end gap-3 pt-6 border-t border-gray-100">
            <button
              onClick={onClose}
              className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={saving}
              className="px-4 py-2 text-sm font-medium text-white bg-blue-600 border border-transparent rounded-lg hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:opacity-50"
            >
              {saving ? "Saving..." : "Save Project"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
