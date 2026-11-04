import { ArrowLeftIcon, HelpCircleIcon, HomeIcon, SettingsIcon, ShieldCheckIcon, TagIcon, UsersIcon, WorkflowIcon } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { NavLink, useLocation } from 'react-router-dom'
import { BrandMark } from '@/components/brand-mark.js'
import { WhaleAnimation } from '@/components/whale-animation.js'
import { SidebarUser } from '@/components/sidebar-user.js'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  SidebarSeparator,
  useSidebar,
} from '@/components/ui/sidebar.js'
import { useSession } from '@/lib/use-session.js'

interface NavItem {
  title: string
  url: string
  icon: LucideIcon
}

export function AppSidebar() {
  const { t } = useTranslation()
  const { pathname } = useLocation()
  const { data: user } = useSession()
  const { isMobile, setOpenMobile } = useSidebar()
  const adminMode = pathname.startsWith('/admin')

  const closeMobileSidebar = () => {
    if (isMobile) setOpenMobile(false)
  }

  const platformNav: NavItem[] = [
    { title: t('nav.home'), url: '/home', icon: HomeIcon },
    { title: t('nav.workspaces'), url: '/workspaces', icon: WorkflowIcon },
  ]
  /** 管理面单独成组：这三项都是管理员专属的作业面，混进「平台」里会让人看不清边界。
   *  藏起来不是安全边界——服务端每条管理面路由都自己查 role。 */
  const adminNav: NavItem[] = [
    { title: t('nav.adminOverview'), url: '/admin', icon: ShieldCheckIcon },
    { title: t('nav.adminInstances'), url: '/admin/instances', icon: WorkflowIcon },
    { title: t('nav.adminUsers'), url: '/admin/users', icon: UsersIcon },
    { title: t('nav.adminVersions'), url: '/admin/versions', icon: TagIcon },
  ]
  const footerNav: NavItem[] = adminMode
    ? [{ title: t('nav.backToWorkspace'), url: '/home', icon: ArrowLeftIcon }]
    : [
        ...(user?.role === 'admin'
          ? [{ title: t('nav.admin'), url: '/admin', icon: ShieldCheckIcon }]
          : []),
        { title: t('nav.account'), url: '/settings/account', icon: SettingsIcon },
      ]

  const isNavItemActive = (url: string) =>
    pathname === url || (url !== '/admin' && pathname.startsWith(`${url}/`))

  const group = (label: string, items: NavItem[], className?: string) => (
    <SidebarGroup className={className}>
      {label !== '' && <SidebarGroupLabel>{label}</SidebarGroupLabel>}
      <SidebarGroupContent>
        <SidebarMenu>
          {items.map((item) => (
            <SidebarMenuItem key={item.url}>
              <SidebarMenuButton
                className="h-9 gap-2.5 px-3 text-[13px] font-normal text-sidebar-foreground/70 transition-colors duration-150 ease-out hover:bg-foreground/[0.05] hover:text-sidebar-foreground hover:[&_svg]:translate-x-px data-active:bg-foreground/[0.07] data-active:font-medium data-active:text-sidebar-foreground [&_svg]:size-4 [&_svg]:transition-transform [&_svg]:duration-200 [&_svg]:ease-out"
                tooltip={item.title}
                // 子页面（如 /instances/:id）也要把这一项点亮
                isActive={isNavItemActive(item.url)}
                render={<NavLink to={item.url} end={item.url === '/admin'} onClick={closeMobileSidebar} />}
              >
                <item.icon />
                <span>{item.title}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ))}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  )

  return (
    <Sidebar collapsible="offcanvas" className="border-r border-border/40 overflow-hidden">
      {/* Background Whale Animation - Adapts to light/dark mode */}
      <div className="absolute inset-0 z-0 pointer-events-none opacity-[0.08] dark:opacity-20 hidden md:block text-[#087f71] dark:text-foreground">
        <div className="absolute -bottom-24 -left-12 w-[150%]">
          <WhaleAnimation className="w-full h-full overflow-visible [&>path]:fill-current [&_g]:fill-current" />
        </div>
      </div>

      <SidebarHeader className="p-2 pb-1 relative z-10">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton className="h-12 justify-start gap-2.5 px-3 transition-colors duration-150 ease-out [&_svg]:!h-9 [&_svg]:!w-11" size="lg" render={<NavLink to="/home" onClick={closeMobileSidebar} />}>
              <BrandMark className="shrink-0 transition-transform duration-300 ease-out group-hover/menu-button:-translate-y-px group-hover/menu-button:scale-[1.03]" />
              <div className="grid text-left leading-tight">
                <span className="truncate text-lg font-medium tracking-[-0.03em] text-foreground">
                  dsh<span className="text-muted-foreground">cloud.</span>
                </span>
              </div>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent className="gap-0 px-1 relative z-10">
        {adminMode ? group(t('nav.admin'), adminNav) : group('', platformNav)}
      </SidebarContent>

      <SidebarFooter className="gap-1 p-2 relative z-10">
        {group('', footerNav, 'p-0')}
        <SidebarGroup className="p-0">
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton className="h-9 gap-2.5 px-3 text-[13px] font-normal text-sidebar-foreground/70 transition-colors duration-150 ease-out hover:bg-foreground/[0.05] hover:text-sidebar-foreground hover:[&_svg]:translate-x-px [&_svg]:size-4 [&_svg]:transition-transform [&_svg]:duration-200 [&_svg]:ease-out" render={<a href="https://github.com/eskim2001/dsh-cloud" target="_blank" rel="noreferrer" onClick={closeMobileSidebar} />}>
                  <HelpCircleIcon />
                  <span>{t('nav.help')}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
        <SidebarSeparator className="mx-1 my-1 opacity-20" />
        <SidebarUser />
      </SidebarFooter>

      <SidebarRail />
    </Sidebar>
  )
}
