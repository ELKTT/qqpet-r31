using System;using System.Diagnostics;using System.Windows.Forms;
namespace QQPet.LocalLogin {
 internal static class DirectEntry {
  [STAThread]private static int Main(){try{
   string root=AppDomain.CurrentDomain.BaseDirectory;
   var configuration=new CompleteLaunchConfiguration(root);
   // The helper stays beside its original activation manifests and Flash OCX.
   // Launch directly, preserving the accepted two-process entry structure.
   Process.Start(new ProcessStartInfo(configuration.LauncherExecutable()){WorkingDirectory=root,UseShellExecute=false});return 0;
  }catch{MessageBox.Show("启动文件不完整或已被修改，请检查完整客户端目录。","QQ宠物",MessageBoxButtons.OK,MessageBoxIcon.Error);return 2;}}
 }
}
