import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// built assets are served by Django under /static/; in dev the API is proxied to runserver
const django = 'http://127.0.0.1:8411'

export default defineConfig({
  plugins: [react()],
  base: '/static/',
  server: { proxy: { '/api': django, '/login': django, '/logout': django } },
})
