#include "engine.h"
#include "render_core.h"
#include "log_wrapper.h"

int main() {
  log_wrapper::Log("APP", "starting");
  const double y = engine::Load("sample.db");
  const double x = render_core::ScreenX(127.0);
  return (x + y) > 0.0 ? 0 : 1;
}
