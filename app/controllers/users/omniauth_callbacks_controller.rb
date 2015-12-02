class Users::OmniauthCallbacksController < Devise::OmniauthCallbacksController
  def google_oauth2

    @user = User.find_or_merge_with_omniauth(request.env["omniauth.auth"], current_user)

    if @user
      flash[:notice] = "success!"
      sign_in_and_redirect @user, :event => :authentication
    else
      flash[:notice] = "sorry. something went wrong."
      redirect_to root_path
    end
  end
end
