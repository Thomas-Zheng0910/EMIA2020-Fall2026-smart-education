import { createContext, useContext } from 'react';
import type { Bootstrap } from '../shared/types';

export const BootContext = createContext<Bootstrap & { reload: () => void; selectCourse: (id: string) => void }>({
  recent: [],
  courses: [],
  enrolled: [],
  course: null,
  lectures: [],
  students: [],
  me: { id: 'thomas', name: 'Thomas', initials: 'T', color: '#2f6fed', role: 'student' },
  ai: { configured: false, model: null },
  reload: () => {},
  selectCourse: () => {},
});
export const useBoot = () => useContext(BootContext);
