export type ManagedNotification = { destroy: () => void }

export function forgetActiveNotification(active: Map<number, ManagedNotification>, cursor: number) {
  active.delete(cursor)
}

export function destroyActiveNotification(active: Map<number, ManagedNotification>, cursor: number) {
  const notification = active.get(cursor)
  active.delete(cursor)
  notification?.destroy()
}

export function destroyAllActiveNotifications(active: Map<number, ManagedNotification>) {
  const notifications = [...active.values()]
  active.clear()
  notifications.forEach((notification) => notification.destroy())
}
