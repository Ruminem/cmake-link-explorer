#include "render_core.h"
#include "math_utils.h"
namespace render_core {
double ScreenX(double longitude) { return math_utils::Project(0.0, longitude); }
}  // namespace render_core
