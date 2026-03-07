import { create } from 'zustand'

type ToastVariant = 'default' | 'success' | 'error' | 'warning'

type ToastItem = {
  id: string
  title: string
  description?: string
  variant?: ToastVariant
}

type ToastStore = {
  toasts: ToastItem[]
  addToast: (toast: Omit<ToastItem, 'id'>) => string
  removeToast: (id: string) => void
}

function createToastId() {
  return `toast-${Math.random().toString(36).slice(2, 10)}`
}

export const useToastStore = create<ToastStore>((set) => ({
  toasts: [],
  addToast: (toast) => {
    const id = createToastId()
    set((state) => ({
      toasts: [...state.toasts, { ...toast, id }],
    }))
    return id
  },
  removeToast: (id) => {
    set((state) => ({
      toasts: state.toasts.filter((toast) => toast.id !== id),
    }))
  },
}))

export function toast(toastInput: Omit<ToastItem, 'id'>) {
  return useToastStore.getState().addToast(toastInput)
}
