export const openModal = (id: string) =>
  document.getElementById(id)?.classList.remove("hidden");
export const closeModal = (id: string) =>
  document.getElementById(id)?.classList.add("hidden");
