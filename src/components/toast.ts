export const showToast = (msg: string, type: "success" | "error", link?: string) => {
  const el = document.createElement("div");
  el.className = `fixed bottom-4 left-4 px-4 py-2 rounded-lg shadow-lg text-sm font-medium ${
    type === "success" ? "bg-green-500" : "bg-red-500"
  } text-white z-[1000]`;
  el.innerHTML = link ? `<a href="${link}" target="_blank" class="underline">${msg}</a>` : msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3200);
};
