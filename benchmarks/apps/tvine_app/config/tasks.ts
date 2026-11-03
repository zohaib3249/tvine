// Task worker config, like Celery's (settings.tasksModule). Tasks live in apps/<app>/tasks.ts (defineTask).
// Run: tvine worker [--beat]

// Queues this worker consumes when --queues is not given (default: all).
export const queues: string[] = []

// Periodic tasks for tvine worker --beat, by task id '<app>.<task>'.
export const beatSchedule = {
  // 'blog.cleanup': { cron: '0 3 * * *' },
  // 'blog.ping': { every: 60_000, args: {} },
}
