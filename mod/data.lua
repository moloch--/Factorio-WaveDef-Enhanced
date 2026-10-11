-- The native island elevation cancels the standard water-size control, and
-- both native generators keep a starting lake even at zero water. Wrap the
-- chosen elevation only on battle surfaces with a non-default water setting.
data:extend({
  { type = "noise-expression", name = "wde_water_amount", expression = 1 },
  { type = "noise-expression", name = "wde_original_elevation", expression = "elevation_nauvis" },
  {
    type = "noise-expression",
    name = "wde_water_elevation",
    expression = "if(wde_water_amount <= 0, max(1, wde_original_elevation), "
      .. "wde_original_elevation - min(0, water_bias) "
      .. "- max(0, water_bias) * clamp((distance - 32) / 64, 0, 1))",
    local_expressions = {
      water_bias = "2 * log2(max(wde_water_amount, 0.01))",
    },
  },
})
