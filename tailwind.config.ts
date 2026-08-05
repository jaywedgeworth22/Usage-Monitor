/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: "class",
  content: ["./src/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: {
    extend: {
      colors: {
        accent: {
          DEFAULT: "var(--um-accent)",
          soft: "var(--um-accent-soft)",
        },
      },
      borderRadius: {
        "um-lg": "var(--um-radius-lg)",
        "um-xl": "var(--um-radius-xl)",
      },
    },
  },
  plugins: [],
};
