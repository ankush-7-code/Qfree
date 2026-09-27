import { lazy, Suspense, type ReactNode } from 'react';
import { Navigate, Outlet, Route, Routes, useLocation } from 'react-router';
import { homeFor, useAuth } from './lib/auth';
import type { Role } from './lib/types';
import { Spinner } from './components/ui/primitives';
import { PublicLayout } from './layouts/PublicLayout';
import { DashboardLayout } from './layouts/DashboardLayout';
import { Landing } from './pages/public/Landing';
import { Login, Register } from './pages/public/Auth';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const lazyNamed = <M extends Record<K, React.ComponentType<any>>, K extends keyof M & string>(loader: () => Promise<M>, name: K) =>
  lazy(() => loader().then((m) => ({ default: m[name] })));

const pub = () => import('./pages/public/Info');
const About = lazyNamed(pub, 'About');
const HowItWorks = lazyNamed(pub, 'HowItWorks');
const NotFound = lazyNamed(pub, 'NotFound');
const Search = lazyNamed(() => import('./pages/public/Search'), 'Search');
const prov = () => import('./pages/public/Provider');
const ProviderDetails = lazyNamed(prov, 'ProviderDetails');
const DoctorDetails = lazyNamed(prov, 'DoctorDetails');
const QueuePage = lazyNamed(() => import('./pages/public/QueuePage'), 'QueuePage');

const pat = () => import('./pages/patient/Patient');
const PatientDashboard = lazyNamed(pat, 'PatientDashboard');
const MyQueues = lazyNamed(pat, 'MyQueues');
const PatientHistory = lazyNamed(pat, 'PatientHistory');
const PatientProfile = lazyNamed(pat, 'PatientProfile');

const shared = () => import('./pages/shared/Shared');
const Notifications = lazyNamed(shared, 'Notifications');
const ReportIssue = lazyNamed(shared, 'ReportIssue');
const EntryDetails = lazyNamed(shared, 'EntryDetails');

const doc = () => import('./pages/doctor/Doctor');
const DoctorDashboard = lazyNamed(doc, 'DoctorDashboard');
const DoctorQueue = lazyNamed(doc, 'DoctorQueue');
const DoctorHistory = lazyNamed(doc, 'DoctorHistory');
const DoctorSchedule = lazyNamed(doc, 'DoctorSchedule');
const DoctorAnalytics = lazyNamed(doc, 'DoctorAnalytics');
const DoctorProfile = lazyNamed(doc, 'DoctorProfile');

const org = () => import('./pages/org/Org');
const OrgDashboard = lazyNamed(org, 'OrgDashboard');
const OrgQueues = lazyNamed(org, 'OrgQueues');
const OrgQueueBoard = lazyNamed(org, 'OrgQueueBoard');
const OrgDoctors = lazyNamed(org, 'OrgDoctors');
const OrgServices = lazyNamed(org, 'OrgServices');
const OrgStaff = lazyNamed(org, 'OrgStaff');
const OrgHours = lazyNamed(org, 'OrgHours');
const OrgReports = lazyNamed(org, 'OrgReports');
const OrgAnalytics = lazyNamed(org, 'OrgAnalytics');
const OrgProfile = lazyNamed(org, 'OrgProfile');
const OrgSetup = lazyNamed(org, 'OrgSetup');

const adm = () => import('./pages/admin/Admin');
const AdminDashboard = lazyNamed(adm, 'AdminDashboard');
const AdminUsers = lazyNamed(adm, 'AdminUsers');
const AdminDoctors = lazyNamed(adm, 'AdminDoctors');
const AdminOrganizations = lazyNamed(adm, 'AdminOrganizations');
const AdminServices = lazyNamed(adm, 'AdminServices');
const AdminQueues = lazyNamed(adm, 'AdminQueues');
const AdminQueueBoard = lazyNamed(adm, 'AdminQueueBoard');
const AdminReports = lazyNamed(adm, 'AdminReports');
const AdminAnalytics = lazyNamed(adm, 'AdminAnalytics');
const AdminSettings = lazyNamed(adm, 'AdminSettings');

function RequireRole({ roles }: { roles: Role[] }) {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) return <Spinner />;
  if (!user) return <Navigate to={`/login?next=${encodeURIComponent(location.pathname + location.search)}`} replace />;
  if (!roles.includes(user.role)) return <Navigate to={homeFor(user.role)} replace />;
  return <Outlet />;
}

/** Shared pages (search, providers, queues) render inside the dashboard when signed in. */
function AdaptiveLayout() {
  const { user, loading } = useAuth();
  if (loading) return <Spinner />;
  return user ? <DashboardLayout /> : <PublicLayout />;
}

const S = ({ children }: { children: ReactNode }) => <Suspense fallback={<Spinner />}>{children}</Suspense>;
const ALL: Role[] = ['PATIENT', 'DOCTOR', 'ORG_ADMIN', 'ADMIN'];

export function App() {
  return (
    <S>
      <Routes>
        <Route element={<PublicLayout />}>
          <Route index element={<Landing />} />
          <Route path="about" element={<About />} />
          <Route path="how-it-works" element={<HowItWorks />} />
          <Route path="login" element={<Login />} />
          <Route path="register" element={<Register />} />
        </Route>

        <Route element={<AdaptiveLayout />}>
          <Route path="search" element={<Search />} />
          <Route path="providers/:id" element={<ProviderDetails />} />
          <Route path="doctors/:id" element={<DoctorDetails />} />
          <Route path="queues/:id" element={<QueuePage />} />
        </Route>

        <Route element={<RequireRole roles={ALL} />}>
          <Route element={<DashboardLayout />}>
            <Route path="notifications" element={<Notifications />} />
            <Route path="report-issue" element={<ReportIssue />} />
          </Route>
        </Route>

        <Route path="patient" element={<RequireRole roles={['PATIENT']} />}>
          <Route element={<DashboardLayout />}>
            <Route index element={<PatientDashboard />} />
            <Route path="queues" element={<MyQueues />} />
            <Route path="history" element={<PatientHistory />} />
            <Route path="profile" element={<PatientProfile />} />
          </Route>
        </Route>

        <Route path="doctor" element={<RequireRole roles={['DOCTOR']} />}>
          <Route element={<DashboardLayout />}>
            <Route index element={<DoctorDashboard />} />
            <Route path="queue" element={<DoctorQueue />} />
            <Route path="queue/:queueId" element={<DoctorQueue />} />
            <Route path="queue/:queueId/entries/:entryId" element={<EntryDetails />} />
            <Route path="history" element={<DoctorHistory />} />
            <Route path="schedule" element={<DoctorSchedule />} />
            <Route path="analytics" element={<DoctorAnalytics />} />
            <Route path="profile" element={<DoctorProfile />} />
            <Route path="setup" element={<OrgSetup />} />
          </Route>
        </Route>

        <Route path="org" element={<RequireRole roles={['ORG_ADMIN']} />}>
          <Route element={<DashboardLayout />}>
            <Route index element={<OrgDashboard />} />
            <Route path="setup" element={<OrgSetup />} />
            <Route path="queues" element={<OrgQueues />} />
            <Route path="queues/:queueId" element={<OrgQueueBoard />} />
            <Route path="queues/:queueId/entries/:entryId" element={<EntryDetails />} />
            <Route path="doctors" element={<OrgDoctors />} />
            <Route path="services" element={<OrgServices />} />
            <Route path="staff" element={<OrgStaff />} />
            <Route path="hours" element={<OrgHours />} />
            <Route path="reports" element={<OrgReports />} />
            <Route path="analytics" element={<OrgAnalytics />} />
            <Route path="profile" element={<OrgProfile />} />
          </Route>
        </Route>

        <Route path="admin" element={<RequireRole roles={['ADMIN']} />}>
          <Route element={<DashboardLayout />}>
            <Route index element={<AdminDashboard />} />
            <Route path="users" element={<AdminUsers />} />
            <Route path="doctors" element={<AdminDoctors />} />
            <Route path="clinics" element={<AdminOrganizations kind="clinics" />} />
            <Route path="laboratories" element={<AdminOrganizations kind="laboratories" />} />
            <Route path="services" element={<AdminServices />} />
            <Route path="queues" element={<AdminQueues />} />
            <Route path="queues/:queueId" element={<AdminQueueBoard />} />
            <Route path="queues/:queueId/entries/:entryId" element={<EntryDetails />} />
            <Route path="reports" element={<AdminReports />} />
            <Route path="analytics" element={<AdminAnalytics />} />
            <Route path="settings" element={<AdminSettings />} />
          </Route>
        </Route>

        <Route element={<PublicLayout />}>
          <Route path="*" element={<NotFound />} />
        </Route>
      </Routes>
    </S>
  );
}
