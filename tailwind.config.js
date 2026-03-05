/** @type {import('tailwindcss').Config} */
module.exports = {
  // Scan static pages and scripts for utility classes.
  content: ["./app/static/**/*.{html,js}"],
  theme: {
    extend: {
      fontFamily: {
        sans: ["Geist Sans", "sans-serif"],
      },
      colors: {
        dark: "#000000",
        light: "#ffffff",
        subtle: "#666666",
        border: "#e5e5e5",
      },
    },
  },
  plugins: [],
};
