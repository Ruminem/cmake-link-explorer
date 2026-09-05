#include "engine.h"
#include "math_utils.h"
#include "store_reader.h"
namespace engine {
double Load(const char* database) {
  store_reader::OpenDatabase(database);
  return math_utils::Project(37.5, 127.0);
}
}  // namespace engine
