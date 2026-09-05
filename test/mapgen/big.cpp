#include <string>
#include <vector>
#include <map>
#include <algorithm>
#include <sstream>

struct Tile { int id; std::string name; std::vector<double> coords; };

std::map<int, Tile> g_tiles;

void load(int n) {
  for (int i = 0; i < n; ++i) {
    Tile t; t.id = i;
    std::ostringstream os; os << "tile_" << i; t.name = os.str();
    t.coords.assign(8, i * 1.5);
    g_tiles[i] = t;
  }
}
std::string describe() {
  std::vector<std::string> names;
  for (auto& kv : g_tiles) names.push_back(kv.second.name);
  std::sort(names.begin(), names.end());
  std::string out;
  for (auto& n : names) out += n + ";";
  return out;
}
int main() { load(50); return (int)describe().size(); }
