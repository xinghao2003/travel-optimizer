import forms from "@tailwindcss/forms";

/** @type {import('tailwindcss').Config} */
export default {
  darkMode: ["class"],
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: "#14212b",
        muted: "#667681",
        canvas: "#f4f7f8",
        line: "#e0e7e9",
        teal: {
          50: "#e8f5f4",
          100: "#d3eeeb",
          600: "#167e78",
          700: "#126b66",
          800: "#105651",
        },
      },
      boxShadow: {
        panel: "0 10px 35px rgba(20, 44, 52, 0.07)",
      },
      fontFamily: {
        sans: ["Inter", "ui-sans-serif", "system-ui", "-apple-system", "BlinkMacSystemFont", "Segoe UI", "sans-serif"],
      },
    },
  },
  plugins: [forms],
};
