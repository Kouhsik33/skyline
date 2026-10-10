import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { Link, NavLink, Outlet, matchPath, useLocation, useMatch, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Buildings, CalendarBlank, CaretDown, ChartLineUp, Check, ClipboardText, Code, CreditCard, Gauge, HandCoins, House, IdentificationBadge, List, Megaphone, Moon,
  Package, QrCode, Receipt, ShoppingBag, SignOut, Sun, Ticket, UserCircle, Users, UsersThree, Wallet, X,
} from '@phosphor-icons/react';
import { useAuth } from '../auth/AuthProvider';
import { clubsApi } from '../api/endpoints';
import { IS_DEMO } from '../api/config';
import { useTheme } from '../components/Theme';
import { Avatar } from '../components/domain';
import Brand from '../components/Brand';
import { Button, IconButton } from '../components/Button';
import { PageLoader } from '../components/feedback';
import { LABELS } from '../utils/status';
import { LAST_CLUB_KEY } from '../auth/clientState';


function useClubs() {
  return useQuery({ queryKey: ['clubs'], queryFn: () => clubsApi.list(), staleTime: 300000 });
}

function useActiveClub(managedIds) {
  const match = useMatch('/manage/:clubId/*');
  const fromUrl = match?.params.clubId;
  const [last, setLast] = useState(() => {
    try {
      return window.localStorage.getItem(LAST_CLUB_KEY);
    } catch {
      return null;
    }
  });
  useEffect(() => {
    if (fromUrl && fromUrl !== 'events' && fromUrl !== 'fundraisers' && managedIds.includes(fromUrl)) {
      setLast(fromUrl);
      try {
        window.localStorage.setItem(LAST_CLUB_KEY, fromUrl);
      } catch {
        /* ignore */
      }
    }
  }, [fromUrl, managedIds]);
  if (fromUrl && managedIds.includes(fromUrl)) return fromUrl;
  if (last && managedIds.includes(last)) return last;
  return managedIds[0] || null;
}

function NavItem({ to, icon: Icon, children, end, onNavigate }) {
  return (
    <NavLink to={to} end={end} className="nav-link" onClick={onNavigate}>
      <Icon size={20} aria-hidden />
      <span>{children}</span>
    </NavLink>
  );
}

function buildNav({ user, clubId, clubName, rolesIn, organizerOf, staffOf }) {
  const sections = [
    {
      heading: 'Discover',
      items: [
        { to: '/', icon: House, label: 'Home', end: true },
        { to: '/events', icon: CalendarBlank, label: 'Events' },
        { to: '/clubs', icon: Buildings, label: 'Clubs' },
        { to: '/announcements', icon: Megaphone, label: 'Announcements' },
      ],
    },
  ];
  if (user) {
    const anyRole = organizerOf.length || staffOf.length;
    sections.push({
      heading: 'My account',
      items: [
        { to: '/me/memberships', icon: IdentificationBadge, label: 'Memberships' },
        { to: '/me/tickets', icon: Ticket, label: 'Tickets' },
        { to: '/me/orders', icon: ShoppingBag, label: 'Orders' },
        { to: '/me/payments', icon: CreditCard, label: 'Payments' },
        anyRole && { to: '/me/duties', icon: QrCode, label: 'Event duties' },
        { to: '/me/tasks', icon: ClipboardText, label: 'My tasks' },
        { to: '/me/expenses', icon: Receipt, label: 'Reimbursements' },
      ].filter(Boolean),
    });
  }
  if (clubId) {
    const roles = rolesIn(clubId);
    const head = roles.includes('CLUB_HEAD');
    const tr = roles.includes('TREASURER');
    sections.push({
      heading: 'Manage',
      subheading: clubName,
      items: [
        { to: `/manage/${clubId}`, icon: Gauge, label: 'Dashboard', end: true },
        (head || tr) && { to: `/manage/${clubId}/members`, icon: Users, label: 'Members' },
        head && { to: `/manage/${clubId}/plans`, icon: IdentificationBadge, label: 'Plans' },
        (head || tr) && { to: `/manage/${clubId}/events`, icon: CalendarBlank, label: 'Events' },
        head && { to: `/manage/${clubId}/announcements`, icon: Megaphone, label: 'Announcements' },
        (head || tr) && { to: `/manage/${clubId}/merchandise`, icon: Package, label: 'Merchandise' },
        (head || tr) && { to: `/manage/${clubId}/orders`, icon: ShoppingBag, label: 'Orders & pickup' },
        { to: `/manage/${clubId}/fundraisers`, icon: HandCoins, label: 'Fundraisers' },
        { to: `/manage/${clubId}/finance`, icon: Wallet, label: 'Finance' },
        (head || tr) && { to: `/manage/${clubId}/reports`, icon: ChartLineUp, label: 'Reports' },
        head && { to: `/manage/${clubId}/roles`, icon: UsersThree, label: 'Team & roles' },
      ].filter(Boolean),
    });
  }
  if (IS_DEMO && user) sections.push({ heading: 'Demo', items: [{ to: '/dev', icon: Code, label: 'Dev tools' }] });
  return sections;
}

// Close a popover on outside click or Escape.
function useDismiss(ref, open, setOpen) {
  useEffect(() => {
    if (!open) return undefined;
    const close = (e) => {
      if (!ref.current?.contains(e.target)) setOpen(false);
    };
    const esc = (e) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', esc);
    };
  }, [ref, open, setOpen]);
}

/** The clubs the user manages; picking one opens its dashboard. */
function ClubOptions({ clubs, managedIds, activeId, onPick }) {
  const navigate = useNavigate();
  const { rolesIn } = useAuth();
  return clubs
    .filter((c) => managedIds.includes(c.id))
    .map((c) => (
      <button
        key={c.id}
        type="button"
        aria-pressed={c.id === activeId}
        className="menu-item"
        onClick={() => {
          onPick?.();
          navigate(`/manage/${c.id}`);
        }}
      >
        <span style={{ flex: 1 }}>
          {c.name}
          <span className="cell-sub" style={{ display: 'block' }}>
            {rolesIn(c.id).map((r) => LABELS.role[r]).join(' · ')}
          </span>
        </span>
        {c.id === activeId && <Check size={16} aria-hidden />}
      </button>
    ));
}

/** A top-bar dropdown for one nav section. Marked current when any of its pages is open. */
function NavMenu({ section, children }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const { pathname } = useLocation();
  useDismiss(ref, open, setOpen);
  useEffect(() => setOpen(false), [pathname]);
  const current = section.items.some((i) => matchPath({ path: i.to, end: !!i.end }, pathname));
  return (
    <div ref={ref} className="topnav-menu">
      <button type="button" className="topnav-link" data-current={current || undefined} aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {section.heading}
        <CaretDown size={12} aria-hidden />
      </button>
      {open && (
        <div className="menu" style={{ left: 0, right: 'auto' }}>
          {children}
          {section.subheading && <div className="nav-heading">{section.subheading}</div>}
          {section.items.map((i) => (
            <NavLink key={i.to} to={i.to} end={i.end} className="menu-item">
              <i.icon size={18} aria-hidden />
              {i.label}
            </NavLink>
          ))}
        </div>
      )}
    </div>
  );
}

function UserMenu() {
  const { user, signOut } = useAuth();
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useDismiss(ref, open, setOpen);
  if (!user) {
    return (
      <div className="row">
        <Button variant="ghost" to="/login">
          Sign in
        </Button>
        <Button variant="primary" to="/register" className="hide-mobile">
          Create account
        </Button>
      </div>
    );
  }
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button type="button" className="btn btn-ghost" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)} aria-label={`Account menu for ${user.fullName}`} style={{ paddingInline: 6 }}>
        <Avatar name={user.fullName} />
        <span className="hide-mobile" style={{ color: 'var(--color-text-primary)' }}>
          {user.fullName.split(' ')[0]}
        </span>
        <CaretDown size={14} aria-hidden />
      </button>
      {open && (
        <div className="menu" role="menu">
          <div style={{ padding: '8px 12px' }}>
            <div className="cell-title">{user.fullName}</div>
            <div className="cell-sub wrap-anywhere">{user.email}</div>
          </div>
          <hr className="divider" style={{ margin: '4px 0' }} />
          <Link role="menuitem" to="/me/profile" className="menu-item" onClick={() => setOpen(false)}>
            <UserCircle size={18} aria-hidden /> Profile & verification
          </Link>
          <hr className="divider" style={{ margin: '4px 0' }} />
          <button
            role="menuitem"
            type="button"
            className="menu-item"
            style={{ color: 'var(--color-danger)' }}
            onClick={async () => {
              setOpen(false);
              await signOut(); // clears all user data and replaces history with /login
            }}
          >
            <SignOut size={18} aria-hidden /> Sign out
          </button>
        </div>
      )}
    </div>
  );
}

export default function AppShell() {
  const auth = useAuth();
  const { user, managedClubIds } = auth;
  const clubs = useClubs();
  const activeClub = useActiveClub(managedClubIds);
  const [navOpen, setNavOpen] = useState(false);
  const { theme, setPreference } = useTheme();
  const location = useLocation();
  const mainRef = useRef(null);
  const headerRef = useRef(null);
  useDismiss(headerRef, navOpen, setNavOpen);

  // Move focus to the page title on navigation (WCAG focus-on-route-change).
  const firstRender = useRef(true);
  useEffect(() => {
    setNavOpen(false);
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    const t = setTimeout(() => {
      const h = mainRef.current?.querySelector('[data-page-title]');
      (h || mainRef.current)?.focus({ preventScroll: true });
      window.scrollTo(0, 0);
    }, 50);
    return () => clearTimeout(t);
  }, [location.pathname]);

  const clubName = (clubs.data || []).find((c) => c.id === activeClub)?.name;
  const sections = useMemo(() => buildNav({ ...auth, clubId: activeClub, clubName }), [auth, activeClub, clubName]);
  const [discover, ...rest] = sections;
  const manyClubs = managedClubIds.length > 1;
  const clubOptions = (onPick) => <ClubOptions clubs={clubs.data || []} managedIds={managedClubIds} activeId={activeClub} onPick={onPick} />;

  return (
    <div className="shell">
      <a href="#main" className="skip-link">
        Skip to main content
      </a>
      {IS_DEMO && (
        <div className="demo-banner" role="note">
          <Code size={16} aria-hidden />
          Demo mode · data is simulated in your browser until the backend is connected
        </div>
      )}
      <header className="topbar" ref={headerRef}>
        <Brand />
        <nav className="topnav" aria-label="Primary">
          {discover.items.map((i) => (
            <NavLink key={i.to} to={i.to} end={i.end} className="topnav-link">
              {i.label}
            </NavLink>
          ))}
          {rest.map((sec) =>
            sec.items.length === 1 ? (
              <NavLink key={sec.heading} to={sec.items[0].to} className="topnav-link">
                {sec.items[0].label}
              </NavLink>
            ) : (
              <NavMenu key={sec.heading} section={sec}>
                {sec.subheading && manyClubs && (
                  <>
                    <div className="nav-heading">Clubs you manage</div>
                    {clubOptions()}
                    <hr className="divider" style={{ margin: '4px 0' }} />
                  </>
                )}
              </NavMenu>
            ),
          )}
        </nav>
        <div className="topbar-spacer" />
        <IconButton icon={theme === 'dark' ? Sun : Moon} label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'} onClick={() => setPreference(theme === 'dark' ? 'light' : 'dark')} />
        <UserMenu />
        <IconButton icon={navOpen ? X : List} label={navOpen ? 'Close navigation' : 'Open navigation'} className="menu-btn" onClick={() => setNavOpen((p) => !p)} aria-expanded={navOpen} aria-controls="mobile-nav" />
        {navOpen && (
          <nav id="mobile-nav" className="mobile-nav" aria-label="Primary">
            {sections.map((s) => (
              <div key={s.heading} className="nav-section">
                <div className="nav-heading">{s.subheading ? `${s.heading} · ${s.subheading}` : s.heading}</div>
                {s.subheading && manyClubs && <div className="mobile-nav-clubs">{clubOptions(() => setNavOpen(false))}</div>}
                {s.items.map((i) => (
                  <NavItem key={i.to} to={i.to} icon={i.icon} end={i.end} onNavigate={() => setNavOpen(false)}>
                    {i.label}
                  </NavItem>
                ))}
              </div>
            ))}
            {!user && (
              <Button variant="primary" to="/register" block>
                Create account
              </Button>
            )}
          </nav>
        )}
      </header>
      <main id="main" ref={mainRef} tabIndex={-1} className="content" style={{ outline: 'none' }}>
        {/* Keyed so each page gets a fresh boundary: the logo shows while its code loads, even mid-transition. */}
        <Suspense key={location.pathname} fallback={<PageLoader />}>
          <Outlet />
        </Suspense>
      </main>
      <footer className="footer">
        <span>Campus Flow · Student organizations</span>
        <nav aria-label="Legal">
          <Link to="/terms">Terms of use</Link>
          <Link to="/privacy">Privacy policy</Link>
        </nav>
      </footer>
    </div>
  );
}
