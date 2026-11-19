# Odoo skills

Copia empaquetada del pack [mart337i/odoo-skills](https://github.com/mart337i/odoo-skills) (MIT según su
`package.json`). El plugin la usa como respaldo: si no encuentra esta carpeta, busca el pack instalado en
`~/.agents/skills`, y la opción `skills` del plugin puede apuntar a otra ruta.

Para actualizar el pack:

```bash
git clone --depth 1 https://github.com/mart337i/odoo-skills.git /tmp/odoo-skills
rsync -a --delete --exclude README.md /tmp/odoo-skills/skills/ ./skills/
```

Las skills se registran automáticamente en cada workspace de Odoo. Además, el plugin genera la skill
`odoo-workspace` con las versiones, configuraciones y los valores recomendados de `ODOO_SOURCE`,
`ODOO_BASE_COMMAND` y `ODOO_TOOL_README` del proyecto abierto.
