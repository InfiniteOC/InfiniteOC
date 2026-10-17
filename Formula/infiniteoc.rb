# Homebrew formula for a tap under the InfiniteOC organization. The repository is
# private: run `gh auth setup-git` (or configure a git credential helper) first so
# brew can clone it.
#   brew tap InfiniteOC/infiniteoc && brew install --HEAD infiniteoc
# InfiniteOC builds into its own directory and updates itself with git, so the formula installs a small wrapper
# that keeps a writable checkout in ~/.infiniteoc (override with INFINITEOC_DIR) instead of a read-only Cellar copy.
class Infiniteoc < Formula
  desc "Source-backed OpenCode launcher and local mod framework"
  homepage "https://github.com/InfiniteOC/InfiniteOC"
  head "https://github.com/InfiniteOC/InfiniteOC.git", branch: "main"
  license :cannot_represent

  depends_on "git"
  depends_on "node"

  def install
    libexec.install "install.sh"
    (bin/"infiniteoc").write <<~SH
      #!/bin/sh
      dir="${INFINITEOC_DIR:-$HOME/.infiniteoc}"
      [ -f "$dir/bin/infiniteoc.mjs" ] || INFINITEOC_DIR="$dir" INFINITEOC_NO_SETUP=1 INFINITEOC_NO_LINK=1 sh "#{libexec}/install.sh" >&2 || exit 1
      exec "#{Formula["node"].opt_bin}/node" "$dir/bin/infiniteoc.mjs" "$@"
    SH
    (bin/"opendaemon").write <<~SH
      #!/bin/sh
      dir="${INFINITEOC_DIR:-$HOME/.infiniteoc}"
      [ -f "$dir/bin/opendaemon.mjs" ] || { echo "Run infiniteoc once first" >&2; exit 1; }
      exec "#{Formula["node"].opt_bin}/node" "$dir/bin/opendaemon.mjs" "$@"
    SH
  end

  def caveats
    <<~EOS
      The repository is private: run `gh auth setup-git` (or set GH_TOKEN) so git can clone it.
      The first run of `infiniteoc` clones InfiniteOC into ~/.infiniteoc and builds it (several minutes).
      Updates come from `infiniteoc update`, not from brew upgrade.
    EOS
  end

  test do
    assert_match "InfiniteOC", shell_output("#{bin}/infiniteoc --help", 0) if File.exist?("#{Dir.home}/.infiniteoc/bin/infiniteoc.mjs")
    assert_predicate bin/"infiniteoc", :executable?
  end
end
