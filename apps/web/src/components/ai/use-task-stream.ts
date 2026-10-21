'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { TaskDTO, TaskEvent } from '@/lib/ai';
import { api } from '@/lib/api-client';

export type StreamState = 'connecting' | 'live' | 'polling';

const ACTIVE = new Set(['pending', 'running']);

/**
 * The AI tasks of one article, kept up to date. It loads the list once, then listens to the server's event
 * stream (server-sent events), so a status change appears as soon as the server has committed it. If the
 * stream cannot be opened it falls back to asking every few seconds while a task is still working.
 */
export function useArticleTasks(articleId: string) {
  const [tasks, setTasks] = useState<TaskDTO[]>([]);
  const [loaded, setLoaded] = useState(false);
  // The component only renders in the browser, where EventSource exists in every supported browser.
  const [stream, setStream] = useState<StreamState>(() => (typeof EventSource === 'undefined' ? 'polling' : 'connecting'));
  const tasksRef = useRef(tasks);
  useEffect(() => {
    tasksRef.current = tasks;
  }, [tasks]);

  const load = useCallback(async () => {
    const result = await api<{ tasks: TaskDTO[] }>(`/api/ai/tasks?articleId=${articleId}`);
    if (result.ok) {
      setTasks(result.data.tasks);
      setLoaded(true);
    }
  }, [articleId]);

  const merge = useCallback((task: TaskDTO) => {
    if (task.articleId !== articleId) return;
    setTasks((current) => {
      const without = current.filter((t) => t.id !== task.id);
      return [task, ...without].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    });
  }, [articleId]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  useEffect(() => {
    if (typeof EventSource === 'undefined') return;
    const source = new EventSource('/api/ai/events');
    source.addEventListener('ready', () => {
      setStream('live');
      // A change may have happened while the stream was down.
      void load();
    });
    source.addEventListener('task', (event) => {
      try {
        const parsed = JSON.parse((event as MessageEvent<string>).data) as TaskEvent;
        merge(parsed.task);
      } catch {
        /* a malformed event is ignored; the next load corrects it */
      }
    });
    source.onerror = () => setStream('polling');
    return () => source.close();
  }, [load, merge]);

  // Without a live stream, look again every few seconds, but only while something is still working.
  useEffect(() => {
    if (stream === 'live') return;
    const timer = window.setInterval(() => {
      if (tasksRef.current.some((t) => ACTIVE.has(t.status))) void load();
    }, 4000);
    return () => window.clearInterval(timer);
  }, [stream, load]);

  return { tasks, loaded, stream, reload: load, merge };
}
