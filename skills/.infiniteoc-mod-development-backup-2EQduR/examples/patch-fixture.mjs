export default {
  id: "infiniteoc-skill-smoke-fixture",
  async setup(api) {
    await api.patch("fixture.txt", source => {
      if (source.split("old\n").length !== 2) throw new Error("Expected one source anchor")
      return source.replace("old\n", () => "new\n")
    })
  },
}