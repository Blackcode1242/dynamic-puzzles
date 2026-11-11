import { defineConfig } from 'vite';

export default defineConfig({
  // Relative assets make the build work both at the domain root and on GitHub Pages.
  base: './',
  server: {
    cors: {
      origin: ['https://www.owlbear.rodeo', 'https://owlbear.rodeo'],
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    target: 'es2020',
  },
});
