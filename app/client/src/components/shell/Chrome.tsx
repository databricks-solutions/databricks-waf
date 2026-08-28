// The application command bar.
//
// The previous shell exposed every record type in a permanent 204px directory. It made the
// implementation model the first thing a customer had to learn and competed with the evidence on
// every page. The approved information architecture has four persistent customer tasks instead:
// Assess, Investigate, Improve and Operate. Routes within the current task are one contextual menu;
// method and administration pages are one secondary utility menu.

import { Link, useLocation } from 'react-router';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@databricks/appkit-ui/react';
import { ChevronDown, LayoutDashboard, Settings2 } from 'lucide-react';
import { canonicalCustomerPath, PRIMARY_TASKS, UTILITIES, taskFor, type PrimaryTask } from './nav';

export function Chrome() {
  const { pathname } = useLocation();
  const currentPath = canonicalCustomerPath(pathname);
  const current = taskFor(pathname);

  return (
    <header className="wa-chrome">
      <Link to="/overview" className="wa-chrome-brand" aria-label="Well-Architected — Dashboard">
        <span aria-hidden className="h-2.5 w-2.5 shrink-0 rounded-xs bg-wa-lava" />
        <span className="truncate font-semibold text-white">Well-Architected</span>
      </Link>

      <Link
        to="/overview"
        className="wa-summary-link"
        aria-current={currentPath === '/overview' ? 'page' : undefined}
      >
        <LayoutDashboard aria-hidden className="h-4 w-4 shrink-0" />
        Dashboard
      </Link>

      <nav id="navigation" tabIndex={-1} className="wa-chrome-scroll" aria-label="Customer tasks">
        {PRIMARY_TASKS.map((task) => (
          <Link
            key={task.label}
            to={task.to}
            className="wa-task-link"
            aria-current={current?.label === task.label ? (currentPath === task.to ? 'page' : 'location') : undefined}
          >
            <task.icon aria-hidden className="h-4 w-4 shrink-0" />
            {task.label}
          </Link>
        ))}
      </nav>

      <div className="wa-chrome-foot">
        {current != null && <TaskMenu task={current} pathname={currentPath} />}
        <UtilityMenu pathname={pathname} />
      </div>
    </header>
  );
}

function TaskMenu({ task, pathname }: { readonly task: PrimaryTask; readonly pathname: string }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className="wa-chrome-menu">
          {task.label} views
          <ChevronDown aria-hidden className="h-3.5 w-3.5" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80">
        <DropdownMenuLabel>
          <span className="wa-caption text-wa-text-secondary">{task.hint}</span>
        </DropdownMenuLabel>
        {task.items.map((item) => (
          <DropdownMenuItem key={item.to} asChild>
            <Link to={item.to} aria-current={ownedBy(item.to, pathname) ? 'page' : undefined}>
              <item.icon aria-hidden />
              <span className="flex min-w-0 flex-col">
                <span className="font-medium">{item.label}</span>
                <span className="wa-caption text-wa-text-secondary">{item.hint}</span>
              </span>
            </Link>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function UtilityMenu({ pathname }: { readonly pathname: string }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className="wa-chrome-menu" aria-label="Open utilities">
          <Settings2 aria-hidden className="h-4 w-4" />
          Utilities
          <ChevronDown aria-hidden className="h-3.5 w-3.5" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80">
        <DropdownMenuLabel>
          <span className="wa-caption text-wa-text-secondary">Methodology, configuration and operational records</span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {UTILITIES.map((item) => (
          <DropdownMenuItem key={item.to} asChild>
            <Link to={item.to} aria-current={ownedBy(item.to, pathname) ? 'page' : undefined}>
              <item.icon aria-hidden />
              <span className="flex min-w-0 flex-col">
                <span className="font-medium">{item.label}</span>
                <span className="wa-caption text-wa-text-secondary">{item.hint}</span>
              </span>
            </Link>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ownedBy(to: string, pathname: string): boolean {
  return to === '/' ? pathname === '/' : pathname === to || pathname.startsWith(`${to}/`);
}
