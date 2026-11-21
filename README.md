# `@opencode/plugin-odoo`

Plugin de **OpenCode** para trabajar con proyectos **Odoo** sin salir del editor: detecta el
workspace de la sesión, gestiona `odoo.conf`, arranca Postgres y Odoo, instala versiones,
sincroniza repositorios y entornos de [adoo.live](https://adoo.live), expone **XML-RPC** al
agente y añade un **panel de Git** con commits redactados por IA.

> No está afiliado a Odoo S.A. ni al equipo de OpenCode.

## Qué incluye

### Workspace y `odoo.conf`

- Detecta el workspace subiendo desde la carpeta de la sesión (`config/*.conf`,
  `docker-compose.yml`, `odoo-<major>/`, `odoo-bin`).
- Varias configuraciones por workspace, con selector y **una versión por `odoo.conf`**.
- Edita `[options]` sin reescribir el fichero: claves nuevas al final, existentes en su sitio,
  comentarios intactos. `addons_path` solo acepta carpetas existentes (una ruta rota hace que
  Odoo devuelva 500 en todos los estáticos).
- Resuelve puertos `db_port` / `http_port` libres en todas las configuraciones a la vez.

### Versiones e instalación

- Instala Odoo **15.0 – 20.0** en `bin/odoo-<major>/`, cada una con su propio `.venv`
  (usa `uv` si está disponible; si no, `python -m venv`).
- Comprueba los `requirements.txt` de cada repositorio de addons y ofrece instalarlos con el
  pip del venv o con `uv pip`.
- Paquetes Python extra por versión, guardados en `requirements-local.txt`.

### Runtime

- **Postgres** con Docker Compose: `up` / `down` / `restart` / `status`.
- **Odoo**: start / stop / restart por configuración, en segundo plano con PID en
  `.odoo-run/<label>.pid` y log en `.odoo-run/<label>.log`.
- Barra inferior con el estado (Postgres, entorno activo, URL local).

### adoo.live

- Login con **OAuth device flow** (scope `profile read database`) y renovación de token.
- Lista de ambientes con búsqueda, proyectos y stacks.
- **Sync** de repositorios del stack **y del ambiente**: clona los que faltan y hace `pull`
  (incluidos privados por SSH). Lee `/environments/<id>/repositories` (`unified_repos`), así que
  incluye los addons extra del proyecto que no están en el stack; ambos se combinan sin duplicados.
  Si un remoto HTTPS pide credenciales, reintenta por SSH y deja el `origin` en SSH para los
  siguientes `pull`.
- **Rebuild**: descarga el backup con `database-pulls` (dump custom o zip con filestore),
  lo guarda en `backups/`, crea la base local, restaura, copia el filestore, neutraliza
  (opcional), sincroniza repos (opcional) y muestra progreso con MB, MB/s y ETA.
- El nombre de la base nueva es `<ambiente>_<fecha>_<aleatorio>`; nunca se borran bases viejas.

### XML-RPC

- Conexiones por nombre, con **Enable** y **Allow writes** por conexión (solo lectura por
  defecto).
- Credenciales en `~/.config/opencode/odoo-rpc.json` con permisos `0600`; el agente solo ve
  el nombre de la conexión.
- Los ambientes de adoo rellenan URL y base de datos desde su detalle (`db_name`) y solo
  piden usuario y contraseña.
- Herramientas: `rpc_connect`, `rpc_saved`, `rpc_use`, `rpc_connections`, `rpc_call`,
  `rpc_search_read`, `rpc_disconnect`.

### Git

- Panel con cabecera fija: repositorio (lista con búsqueda), rama, upstream, `↑/↓` y
  **Fetch / Pull (`--ff-only`) / Push**.
- Secciones **Cambios**, **Historial** y **Stash**, con refresco automático del repo activo.
- Stage/unstage por archivo y en bloque, stats `+/-`, diff coloreado con ajuste de línea,
  descartar cambios (con confirmación), copiar ruta y mostrar en el gestor de archivos.
- Los archivos se agrupan **por carpeta**, plegables una a una, con contador y stage/unstage de
  la carpeta completa.
- **Commit** multilínea con contador, `Cmd/Ctrl+Enter` y botón 🧠 que **solo redacta** el
  mensaje leyendo el `git diff --staged` (modelo del compositor o el del servidor; si ninguno
  responde, escribe un mensaje básico con los archivos).
- **Reglas de commit**: texto libre y/o archivo de skill/contexto por workspace que se añade
  al prompt de redacción (por ejemplo Conventional Commits, tipos, scopes e idioma).
- **Historial** con detalle de cada commit y **undo** (`reset --soft HEAD~N`) con selector de
  cuántos commits deshacer; los cambios quedan en Staged.
- Ramas: cambiar, crear desde otra, y **stash** (push / pop / apply / drop con confirmación).
- Herramienta `git` para el agente: `repos`, `status`, `diff`, `stage`, `unstage`, `commit`,
  `checkout`, `create-branch`, `stash`.

### Clonar repositorios

- Botón **Clone repository** en *Configuration* y en el diálogo de repositorios del panel Git.
- Acepta URL completas (HTTPS/SSH) o el atajo `org/repo` (GitHub por defecto), rama opcional y
  clonación por SSH.
- Clona en `repo/<org>/<name>` y, si se deja activado, añade la carpeta al `addons_path` de la
  configuración activa.
- Un clon existente se actualiza con `fetch` + `pull --ff-only`.
- Si un clon HTTPS falla porque el repositorio es privado, reintenta automáticamente por SSH.
- **Update repositories** (Configuration): al abrirlo hace `fetch` y muestra solo los repos que
  **no están en el último commit de su rama** (`behind`, `diverged`, errores), con un botón para
  actualizar **solo ese repositorio** o **Update all**. Usa `merge --ff-only`; con **Discard
  local changes** usa `reset --hard`.
- Cada ejecución queda registrada en `.odoo-run/repos-update.log` (fecha, repo, rama, commit
  anterior→nuevo y estado), y el diálogo muestra ese registro en vivo.
- Herramienta `clone` del namespace `odoo` para el agente; no requiere adoo.live.

### Panel

El panel lateral se organiza en secciones (barra superior del panel):

- **Home** — estado del workspace, Postgres, entorno activo (start/stop/restart/log/URL), URL con `?debug=assets` para desarrollo de assets, instalación de versiones y **Debug**.
- **Configuration** — `odoo.conf` (valores, secciones como `[queue_job]`, opciones añadidas), addons con requisitos, Python del venv y paquetes.
- **Modules** — módulos de la base elegida: instalar, actualizar y ejecutar tests.
- **Database** — bases locales (tamaño y filestore), crear con/sin demo, duplicar, borrar, backup y restore.
- **Logs** — sigue en vivo el log del `odoo.conf` activo (`logfile` o `.odoo-run/<label>.log`), con autoscroll, colores por nivel y filtro de errores. El texto se puede seleccionar y copiar, y el botón **Copy log** copia lo visible.
- **adoo.live** y **XML-RPC**.

### Ciclo de desarrollo

- **Install / Upgrade** de un módulo desde el panel (`-i`, `-u`, `--stop-after-init`, `--no-http`) con log en
  `.odoo-run/<label>-modules.log`.
- **Tests** de un módulo con `--test-enable --test-tags /<módulo>`.
- **Odoo shell**: ejecuta Python (`env`, `self`, …) contra la base elegida sin abrir una terminal.
- **Debug**: arranca Odoo bajo `debugpy` en `127.0.0.1:5678` y añade la configuración `Odoo: attach` a
  `.vscode/launch.json`.
- **dev = all** editable como una opción más de la configuración.
- Bases de datos locales: crear (con demo opcional), duplicar con filestore, borrar, backup `pg_dump -Fc` y
  restore de `.dump` o `.sql`.

### Comando `odoo`

- Genera `<workspace>/bin/odoo`, que ejecuta la versión y el `odoo.conf` activos:
  `odoo shell -d db`, `odoo -u modulo -d db`, `odoo --version`.
- Botón **odoo command** para instalar un despachador en `~/.local/bin/odoo` que ejecuta el
  `bin/odoo` del workspace más cercano, así varios proyectos conviven sin pisarse.

### Skills y contexto Odoo

- Registra automáticamente el pack [odoo-skills](https://github.com/mart337i/odoo-skills) (21
  skills de Odoo 17–20, revisión, migración, reportes, OWL, web, tests y planificación) en cada
  sesión de un workspace Odoo. Prioridad de packs: opción `skills` del plugin, copia del
  proyecto, copia empaquetada en `skills/` y pack en `~/.agents/skills`.
- **Instala el pack en cada proyecto**: al instalar Odoo (y a demanda desde el panel) clona
  `mart337i/odoo-skills` en `<workspace>/.agents/skills/odoo-skills` y lo actualiza con
  `pull --ff-only`; la carpeta queda en el `.gitignore` del proyecto.
- **Estado en el panel (Home)**: muestra el pack con número de skills y último commit, con
  botones para instalarlo o actualizarlo cuando quieras.
- Genera la skill `odoo-workspace` con el root, las versiones, las configuraciones, los
  `addons_path` y los valores recomendados del proyecto abierto.
- Exporta `ODOO_SOURCE`, `ODOO_BASE_COMMAND` y `ODOO_TOOL_README` al proceso para que `exec` y la
  shell los vean. Respeta las variables que hayas exportado tú y actualiza las que puso el
  plugin al cambiar de workspace; `recommend` las recalcula a demanda. `context` las muestra.

### Herramientas del agente (namespace `odoo`)

`detect`, `init`, `install`, `clone`, `conf_get`, `conf_set`, `addons_path_add`, `get`, `postgres`,
`start`, `stop`, `restart`, `context`, `recommend`, `modules`, `module`, `search`, `update`,
`shell`, `exec`, `git` y las de XML-RPC.

## XML-RPC: cómo usarlo

El agente nunca ve las credenciales: se guardan en `~/.config/opencode/odoo-rpc.json` (`0600`)
y se abren por nombre.

1. `rpc_connect` — URL, base, usuario y contraseña o API key (las pide al usuario, no las
   inventa). Devuelve el `uid` y la versión.
2. `rpc_saved` / `rpc_use` — abre una conexión ya guardada por su nombre.
3. `rpc_connections` — lista las abiertas (sin contraseñas).
4. `rpc_call` — `model`, `method`, `args`, `kwargs`; se traduce a `execute_kw`.
5. `rpc_search_read` — atajo de `search_read`.

Ejemplo de lectura con relacionales:

```jsonc
// rpc_connect
{ "url": "https://erp.cliente.com", "database": "cliente", "username": "admin", "password": "•••" }
```

```jsonc
// rpc_call
{
  "model": "res.partner",
  "method": "search_read",
  "args": [[["is_company", "=", true]], ["name", "country_id", "child_ids", "category_id"]],
  "kwargs": { "limit": 5 }
}
```

Devuelve los relationales completos:

```jsonc
[
  { "name": "ACME", "country_id": [238, "Venezuela"], "child_ids": [124], "category_id": [1] }
]
```

También funcionan `read_group` (`country_id: [238, "Venezuela"]`), `name_search`
(`[[28, "A2 Venezuela"]]`), `fields_get` (struct de structs), `read`, `search_count` y
`web_read`.

- **Solo lectura por defecto**: `search_read`, `read`, `read_group`, `name_search`,
  `fields_get`, `search_count`, etc. Para `create`, `write`, `unlink` hay que activar
  **Allow writes** en esa conexión.
- Referencia oficial (usa la versión mayor de tu workspace, p. ej. `18.0`):
  `https://www.odoo.com/documentation/<version>/developer/reference/external_api.html`


## Instalación

Clona el repositorio, instala dependencias y genera el bundle de la GUI:

```bash
git clone https://github.com/andyengit/opencode-plugin-odoo.git ~/dev/opencode-plugin-odoo
cd ~/dev/opencode-plugin-odoo
bun install
bun run build:gui
```

Apunta OpenCode a la carpeta:

```jsonc
// ~/.config/opencode/opencode.jsonc
{
  "plugin": ["/Users/tu-usuario/dev/opencode-plugin-odoo"]
}
```

El paquete está pensado para publicarse como `@opencode/plugin-odoo`; hasta entonces, usa la
ruta local (o `bun pm pack` / instala desde el tag de GitHub).

## Requisitos

- **Bun** para compilar y ejecutar los tests.
- **Docker** con Compose para Postgres.
- `uv` (recomendado) o Python 3.10+ para crear los virtualenvs.
- macOS o Linux; en macOS se añaden las rutas de Homebrew (`libpq`, `openldap`, `openssl@3`).

## Seguridad

- Los tokens de adoo.live viven en el almacén del plugin; nunca se registran.
- Los credenciales XML-RPC están en `~/.config/opencode/odoo-rpc.json` (`0600`) y no se
  envían al modelo.
- Las escrituras por XML-RPC están bloqueadas salvo que la conexión tenga **Allow writes**.

## Desarrollo

```bash
bun install
bun test             # tests del núcleo
bun run typecheck    # bun check
bun run build:gui    # dist/gui-experimental.cjs
```

Estructura:

- `index.ts` — plugin de servidor y herramientas del agente.
- `src/` — lógica sin GUI (workspace, config, docker, proceso, install, adoo, rpc, git, cli…).
- `src/gui/` — plugin de escritorio (`renderer.tsx`, `main.ts`, `controls.tsx`, `git.tsx`).
- `test/` — tests de la lógica pura con `bun test`.

## Licencia

MIT
