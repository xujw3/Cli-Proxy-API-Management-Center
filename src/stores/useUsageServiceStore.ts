import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { normalizeUsageServiceBase } from '@/services/api/usageService';

interface UsageServiceState {
  enabled: boolean;
  serviceBase: string;
  queue: string;
  popSide: 'left' | 'right';
  setEnabled: (enabled: boolean) => void;
  setServiceBase: (serviceBase: string) => void;
  setQueue: (queue: string) => void;
  setPopSide: (popSide: 'left' | 'right') => void;
}

export const useUsageServiceStore = create<UsageServiceState>()(
  persist(
    (set) => ({
      enabled: false,
      serviceBase: 'http://localhost:18317',
      queue: 'usage',
      popSide: 'right',

      setEnabled: (enabled) => set({ enabled }),
      setServiceBase: (serviceBase) => set({ serviceBase: normalizeUsageServiceBase(serviceBase) }),
      setQueue: (queue) => set({ queue: queue.trim() || 'usage' }),
      setPopSide: (popSide) => set({ popSide }),
    }),
    {
      name: 'usage-service-settings',
    }
  )
);
