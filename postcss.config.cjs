module.exports = {
  plugins: {
    // Vite performs the single final Lightning CSS optimization using the
    // application's explicit browser targets; avoid lowering colors twice.
    '@tailwindcss/postcss': { optimize: false },
  },
};
