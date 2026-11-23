// Proyecto de Supabase del visor. La clave "publishable" está hecha para ir en el navegador: lo que cada usuario puede
// leer lo deciden las reglas RLS de la base (solo usuarios con sesión, solo lectura).
export const SUPABASE_URL = 'https://agfcwepbdkcojykvnqpj.supabase.co'
export const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_hHcoYwq52BsNpvEhwYiZjw_DwklA3dT'

// Un equipo se considera desconectado si no envía su estado en este tiempo.
export const OFFLINE_AFTER_MS = 3 * 60 * 1000
